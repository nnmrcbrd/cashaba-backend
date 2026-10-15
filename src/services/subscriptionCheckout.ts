import { randomUUID } from 'node:crypto';
import type { Subscription } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { FinancialError, fingerprint, jsonValue, withFinancialOperation, type FinancialTx } from './financialOperation';
import { isPaidPlan, PLAN_CATALOG, type PaidPlan } from '@/utils/subscriptionPolicy';
import { cancelPayMongoSubscription, expireTestCheckout, PayMongoError } from './paymongo';

// FinancialOperation is an existing durable, user-scoped operation journal.
// Reserve BEFORE contacting PayMongo; remote calls never hold a DB transaction.
const CURRENT_KEY = 'billing:checkout:current';
type CheckoutProvider = 'PAYMONGO_TEST' | 'PAYMONGO';
type CheckoutState = 'PROCESSING' | 'READY' | 'UNCERTAIN' | 'CLOSED';
interface CheckoutRecord {
  state: CheckoutState;
  attemptId: string;
  operationKey: string;
  provider: CheckoutProvider;
  plan: PaidPlan;
  startedAt: string;
  result?: { id: string };
}
export class CheckoutError extends FinancialError {
  constructor(message: string, public readonly code: string, status = 409) { super(message, status); }
}
function record(value: unknown): CheckoutRecord {
  const entry = value as CheckoutRecord;
  if (!entry || !['PROCESSING', 'READY', 'UNCERTAIN', 'CLOSED'].includes(entry.state) || !entry.attemptId || !entry.operationKey) {
    throw new CheckoutError('Your earlier checkout needs verification. A second checkout was blocked.', 'CHECKOUT_UNCERTAIN');
  }
  return entry;
}
export function checkoutRequestKey(key?: string) {
  if (key !== undefined && !/^[a-zA-Z0-9:_-]{8,160}$/.test(key)) throw new CheckoutError('Invalid idempotency key.', 'INVALID_IDEMPOTENCY_KEY', 400);
  // Older clients still receive the same per-account protection.
  return key ?? randomUUID();
}
const blocked = () => new CheckoutError('Your first checkout is still processing or its result is unconfirmed. A second checkout was blocked to avoid another payment. Refresh payment status before trying again.', 'CHECKOUT_IN_PROGRESS');

export async function checkoutState(userId: string) {
  const entry = await prisma.financialOperation.findUnique({ where: { userId_key: { userId, key: CURRENT_KEY } } });
  return entry ? record(entry.result).state : null;
}

export async function assertCheckoutNotProcessing(tx: FinancialTx, userId: string) {
  const entry = await tx.financialOperation.findUnique({ where: { userId_key: { userId, key: CURRENT_KEY } } });
  if (entry && ['PROCESSING', 'UNCERTAIN'].includes(record(entry.result).state)) throw blocked();
}

export async function closeCheckout(tx: FinancialTx, userId: string) {
  const current = await tx.financialOperation.findUnique({ where: { userId_key: { userId, key: CURRENT_KEY } } });
  if (!current) return;
  const entry = record(current.result);
  const result = jsonValue({ ...entry, state: 'CLOSED' });
  await tx.financialOperation.update({ where: { id: current.id }, data: { result } });
  await tx.financialOperation.updateMany({ where: { userId, key: entry.operationKey }, data: { result } });
}

// Called under the same user lock by member/admin cancellation and deletion.
// Closing only the local row leaves a payable URL open at the provider.
export async function cancelCheckout(tx: FinancialTx, userId: string) {
  await assertCheckoutNotProcessing(tx, userId);
  const current = await tx.subscription.findUnique({ where: { userId } });
  if (!current || ['CANCELLED', 'EXPIRED'].includes(current.status)) return current;
  if (current.providerSubscriptionId) {
    if (current.provider === 'PAYMONGO') await cancelPayMongoSubscription(current.providerSubscriptionId);
    // A fulfilled test checkout is a one-time payment, not recurring billing.
    // PayMongo cannot expire a paid session; only unpaid checkouts need closing.
    else if (current.provider === 'PAYMONGO_TEST' && !isPaidPlan(current.plan)) await expireTestCheckout(current.providerSubscriptionId);
  }
  await tx.subscription.update({ where: { userId }, data: { plan: 'FREE', status: 'CANCELLED', cancelAtPeriodEnd: false, cancelledAt: new Date() } });
  await closeCheckout(tx, userId);
  return current;
}

export async function runSubscriptionCheckout<T extends { id: string }>(input: {
  userId: string;
  key?: string;
  provider: CheckoutProvider;
  plan: PaidPlan;
  phone?: string;
  create: (attemptId: string, existing: Subscription | null) => Promise<T>;
  save: (tx: FinancialTx, remote: T) => Promise<unknown>;
}) {
  const { userId, provider, plan } = input;
  const operationKey = `billing:checkout:request:${checkoutRequestKey(input.key)}`;
  const payloadHash = fingerprint({ provider, plan, amount: PLAN_CATALOG[plan].priceCents, phone: input.phone ?? null });
  const claimed = await withFinancialOperation(userId, async tx => {
    const previous = await tx.financialOperation.findUnique({ where: { userId_key: { userId, key: operationKey } } });
    if (previous && previous.payloadHash !== payloadHash) throw new CheckoutError('This retry key was already used for a different plan or checkout request.', 'IDEMPOTENCY_KEY_REUSED');
    const current = await tx.financialOperation.findUnique({ where: { userId_key: { userId, key: CURRENT_KEY } } });
    const active = current ? record(current.result) : null;
    const existing = await tx.subscription.findUnique({ where: { userId } });
    if (isPaidPlan(existing?.plan) && existing!.status === 'ACTIVE' && existing!.currentPeriodEnd > new Date()) {
      throw new CheckoutError('A paid plan is already active. No new checkout was created.', 'SUBSCRIPTION_ALREADY_ACTIVE');
    }
    if (previous && record(previous.result).state === 'CLOSED') throw new CheckoutError('This checkout was closed. Start a new checkout with a new retry key.', 'CHECKOUT_CLOSED');
    if (active && ['PROCESSING', 'UNCERTAIN'].includes(active.state)) {
      if (current!.payloadHash !== payloadHash || !active.result || active.state === 'PROCESSING') throw blocked();
      // A provider result saved after a local DB failure can be finalized safely
      // without making a second provider POST.
      const recovering = { ...active, state: 'PROCESSING' as const };
      await tx.financialOperation.update({ where: { id: current!.id }, data: { result: jsonValue(recovering) } });
      await tx.financialOperation.update({ where: { userId_key: { userId, key: active.operationKey } }, data: { result: jsonValue(recovering) } });
      return { entry: recovering, existing, remote: active.result as T, replay: false };
    }
    const recurringOutstanding = existing?.provider === 'PAYMONGO' && existing.providerSubscriptionId && !['CANCELLED', 'EXPIRED'].includes(existing.status);
    if (recurringOutstanding && !(existing.plan === 'FREE' && existing.status === 'ACTIVE')) {
      throw new CheckoutError('Cancel the earlier recurring subscription before starting another checkout.', 'CHECKOUT_ALREADY_PENDING');
    }
    const pending = existing && existing.providerSubscriptionId && ((existing.provider === 'PAYMONGO_TEST' && existing.plan === 'FREE' && existing.status === 'ACTIVE') || recurringOutstanding);
    if (pending && (existing.provider !== provider || (existing.requestedPlan ?? 'PLUS') !== plan || (existing.checkoutAmountCents ?? 9900) !== PLAN_CATALOG[plan].priceCents)) {
      throw new CheckoutError('An earlier checkout is already pending. Continue or cancel that checkout before choosing another plan.', 'CHECKOUT_ALREADY_PENDING');
    }
    if (active?.state === 'READY' && pending && active.result?.id === existing.providerSubscriptionId) {
      if (current!.payloadHash !== payloadHash) throw new CheckoutError('An earlier checkout is already pending. Continue it before changing checkout details.', 'CHECKOUT_ALREADY_PENDING');
      if (!previous) await tx.financialOperation.create({ data: { userId, key: operationKey, payloadHash, result: jsonValue(active) } });
      return { entry: active, existing, remote: active.result as T, replay: true };
    }
    if (previous) throw new CheckoutError('This checkout is no longer current. Start a new checkout with a new retry key.', 'CHECKOUT_CLOSED');
    const entry: CheckoutRecord = { state: 'PROCESSING', attemptId: randomUUID(), operationKey, provider, plan, startedAt: new Date().toISOString() };
    await tx.financialOperation.create({ data: { userId, key: operationKey, payloadHash, result: jsonValue(entry) } });
    await tx.financialOperation.upsert({ where: { userId_key: { userId, key: CURRENT_KEY } },
      create: { userId, key: CURRENT_KEY, payloadHash, result: jsonValue(entry) }, update: { payloadHash, result: jsonValue(entry) } });
    return { entry, existing, remote: undefined, replay: false };
  });
  if (claimed.replay) return claimed.remote!;
  let remote = claimed.remote;
  try {
    remote ??= await input.create(claimed.entry.attemptId, claimed.existing);
    return await withFinancialOperation(userId, async tx => {
      await input.save(tx, remote!);
      const result = jsonValue({ ...claimed.entry, state: 'READY', result: remote });
      await tx.financialOperation.update({ where: { userId_key: { userId, key: claimed.entry.operationKey } }, data: { result } });
      await tx.financialOperation.update({ where: { userId_key: { userId, key: CURRENT_KEY } }, data: { result } });
      return remote!;
    });
  } catch (error) {
    // Even across restarts and a provider timeout, never open another payment
    // request while the first outcome is unknown. Preserve any known remote ID.
    try {
      await withFinancialOperation(userId, async tx => {
        const rejected = !remote && error instanceof PayMongoError && [400, 401, 403, 404, 422].includes(error.status);
        const result = jsonValue({ ...claimed.entry, state: rejected ? 'CLOSED' : 'UNCERTAIN', ...(remote ? { result: remote } : {}) });
        await tx.financialOperation.update({ where: { userId_key: { userId, key: claimed.entry.operationKey } }, data: { result } });
        await tx.financialOperation.update({ where: { userId_key: { userId, key: CURRENT_KEY } }, data: { result } });
      });
    } catch { /* The durable PROCESSING reservation still prevents duplicates. */ }
    throw error;
  }
}
