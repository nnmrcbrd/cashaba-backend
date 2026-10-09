import { prisma, qualifiedTable } from '@/lib/prisma';
import { PLAN_CATALOG, PLAN_LIMITS, subscriptionAccess } from '@/utils/subscriptionPolicy';
import { checkoutState } from './subscriptionCheckout';
export { PLAN_LIMITS } from '@/utils/subscriptionPolicy';

export type UsageMetric = 'aiRequests' | 'receiptScans';
export class TrialExpiredError extends Error {
  status = 402;
  code = 'TRIAL_EXPIRED';
  constructor() { super('Your 14-day trial has ended. Choose a paid plan to continue. Viewing and exporting existing records remains available.'); }
}

export class UsageLimitError extends Error {
  status = 429;
  constructor(public metric: UsageMetric, public limit: number, public resetAt = monthlyPeriod().periodEnd) {
    super(`Monthly ${metric === 'aiRequests' ? 'AI request' : 'receipt scan'} limit reached. Choose a higher plan or wait for the next usage period.`);
  }
}

export function monthlyPeriod(now = new Date()) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

export async function getProductAccess(userId: string, now = new Date()) {
  const [user, subscription] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { trialStartedAt: true } }),
    prisma.subscription.findUnique({ where: { userId } }),
  ]);
  return subscriptionAccess(user.trialStartedAt, subscription, now);
}

export async function getSubscriptionSummary(userId: string, now = new Date()) {
  const { periodStart, periodEnd } = monthlyPeriod(now);
  const [user, subscription, usage, checkoutStatus] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { trialStartedAt: true } }),
    prisma.subscription.findUnique({ where: { userId } }),
    prisma.usagePeriod.findUnique({ where: { userId_periodStart: { userId, periodStart } } }),
    checkoutState(userId),
  ]);
  const access = subscriptionAccess(user.trialStartedAt, subscription, now);
  const { plan, limits } = access;
  const used = { aiRequests: usage?.aiRequests ?? 0, receiptScans: usage?.receiptScans ?? 0 };
  return {
    userId,
    checkoutState: checkoutStatus,
    ...access,
    plans: (['BASIC', 'STANDARD', 'PREMIUM'] as const).map(id => ({ id, ...PLAN_CATALOG[id], currency: 'PHP', interval: 'monthly' })),
    requestedPlan: subscription?.requestedPlan ?? null,
    checkoutAmountCents: subscription?.checkoutAmountCents ?? null,
    status: subscription?.status ?? 'ACTIVE',
    provider: subscription?.provider ?? 'INTERNAL',
    currentPeriodStart: subscription?.currentPeriodStart ?? periodStart,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? periodEnd,
    usagePeriodStart: periodStart,
    usagePeriodEnd: periodEnd,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    paymentPending: ['PAYMONGO', 'PAYMONGO_TEST'].includes(subscription?.provider ?? '') && subscription?.plan === 'FREE' && subscription.status === 'ACTIVE' && Boolean(subscription.providerSubscriptionId),
    providerActionRequired: subscription?.provider === 'PAYMONGO' && Boolean(subscription.providerSubscriptionId) && !['CANCELLED', 'EXPIRED'].includes(subscription.status) && plan === 'FREE' && !(subscription.plan === 'FREE' && subscription.status === 'ACTIVE' && process.env.BILLING_MODE === 'paymongo'),
    used,
    limits,
    remaining: { aiRequests: Math.max(0, limits.aiRequests - used.aiRequests), receiptScans: Math.max(0, limits.receiptScans - used.receiptScans) },
    demoAvailable: process.env.NODE_ENV !== 'production' && (process.env.BILLING_MODE ?? 'demo') === 'demo',
    billingMode: process.env.BILLING_MODE ?? 'demo',
    testCheckoutAvailable: process.env.BILLING_MODE === 'paymongo_test' && Boolean(process.env.PAYMONGO_SECRET_KEY?.trim().startsWith('sk_test_')),
  };
}

export async function consumeUsage(userId: string, metric: UsageMetric) {
  const now = new Date();
  const { periodStart, periodEnd } = monthlyPeriod(now);
  return prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT "id" FROM ${qualifiedTable('User')} WHERE "id" = $1 FOR UPDATE`, userId);
    const subscription = await tx.subscription.findUnique({ where: { userId } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { trialStartedAt: true } });
    const access = subscriptionAccess(user.trialStartedAt, subscription, now);
    if (!access.canWrite) throw new TrialExpiredError();
    const limit = PLAN_LIMITS[access.plan][metric];
    const usage = await tx.usagePeriod.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      create: { userId, periodStart, periodEnd },
      update: { periodEnd },
    });
    if (usage[metric] >= limit) throw new UsageLimitError(metric, limit, periodEnd);
    return tx.usagePeriod.update({ where: { id: usage.id }, data: { [metric]: { increment: 1 } } });
  });
}

export async function refundUsage(userId: string, metric: UsageMetric, usagePeriodId: string) {
  await prisma.usagePeriod.updateMany({
    where: { id: usagePeriodId, userId, [metric]: { gt: 0 } },
    data: { [metric]: { decrement: 1 } },
  });
}
