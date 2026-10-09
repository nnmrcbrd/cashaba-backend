import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma, qualifiedTable } from '@/lib/prisma';
import { getSubscriptionSummary, monthlyPeriod } from '@/services/subscription';
import { assertPayMongoConfigured, createCustomer, createPaidPlan, createSubscription, retrievePayMongoSubscription, PayMongoError, verifyPayMongoSignature } from '@/services/paymongo';
import { PLAN_CATALOG, isPaidPlan } from '@/utils/subscriptionPolicy';
import { startTestCheckout, syncTestCheckout } from '@/services/testCheckout';
import { FinancialError, requestOperation, withFinancialOperation } from '@/services/financialOperation';
import { assertCheckoutNotProcessing, cancelCheckout, CheckoutError, closeCheckout, runSubscriptionCheckout } from '@/services/subscriptionCheckout';

const payMongoEventSchema = z.object({
  data: z.object({
    id: z.string().min(1).max(200),
    attributes: z.object({
      type: z.enum(['subscription.activated', 'subscription.past_due', 'subscription.unpaid', 'subscription.updated', 'subscription.invoice.paid', 'subscription.invoice.payment_failed']),
      livemode: z.boolean(),
      created_at: z.number().int().positive().optional(),
      data: z.object({
        id: z.string().min(1).max(200),
        type: z.enum(['subscription', 'invoice']),
        attributes: z.object({
          customer_id: z.string().max(200).optional(),
          resource_id: z.string().max(200).optional(),
          amount: z.number().int().positive().optional(),
          currency: z.string().optional(),
          subscription: z.object({ id: z.string(), plan: z.object({ id: z.string() }).passthrough().optional() }).passthrough().optional(),
          status: z.string().max(40),
          next_billing_schedule: z.string().optional().nullable(),
          cancelled_at: z.union([z.number(), z.string()]).optional().nullable(),
        }).passthrough(),
      }),
    }),
  }),
});

const planSelectionSchema = z.object({ plan: z.enum(['BASIC', 'STANDARD', 'PREMIUM']).default('BASIC') });
const startSubscriptionSchema = planSelectionSchema.extend({
  phone: z.string().trim().regex(/^\+639\d{9}$/, 'Enter a Philippine mobile number in +639XXXXXXXXX format.'),
});

function handlePayMongoError(error: unknown, res: Response) {
  if (error instanceof CheckoutError) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return true;
  }
  if (error instanceof PayMongoError) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return true;
  }
  return false;
}

function nextMonthlyPeriod(nextBilling?: string | null) {
  const start = new Date();
  const parsed = nextBilling ? new Date(`${nextBilling}T00:00:00.000Z`) : null;
  if (parsed && !Number.isNaN(parsed.getTime()) && parsed > start) return { periodStart: start, periodEnd: parsed };
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
  return { periodStart: start, periodEnd: end };
}

export async function getMySubscription(req: Request, res: Response) {
  const initial = await getSubscriptionSummary(req.user!.userId);
  if (initial.provider === 'PAYMONGO_TEST' && initial.paymentPending && initial.testCheckoutAvailable) {
    try { await syncTestCheckout(req.user!.userId); }
    catch (error) {
      if (error instanceof PayMongoError) return res.json({ ...initial, checkoutVerificationError: 'PayMongo payment verification is temporarily unavailable. Try checking again.' });
      throw error;
    }
  }
  res.json(await getSubscriptionSummary(req.user!.userId));
}

export async function startPayMongoTestCheckout(req: Request, res: Response) {
  try {
    const input = planSelectionSchema.safeParse(req.body ?? {});
    if (!input.success) return res.status(400).json({ message: 'Choose Basic, Standard or Premium.' });
    const checkout = await startTestCheckout(req.user!.userId, input.data.plan, req.get('Idempotency-Key'));
    res.status(201).json({ checkoutUrl: checkout.attributes.checkout_url, testMode: true, subscription: await getSubscriptionSummary(req.user!.userId) });
  } catch (error) {
    if (!handlePayMongoError(error, res)) {
      if (error instanceof Error && 'status' in error && typeof error.status === 'number') return res.status(error.status).json({ message: error.message });
      throw error;
    }
  }
}

export async function verifyPayMongoTestCheckout(req: Request, res: Response) {
  try {
    await syncTestCheckout(req.user!.userId);
    res.json(await getSubscriptionSummary(req.user!.userId));
  } catch (error) { if (!handlePayMongoError(error, res)) throw error; }
}

export async function startPayMongoSubscription(req: Request, res: Response) {
  try {
    if ((process.env.BILLING_MODE ?? 'demo') !== 'paymongo') return res.status(503).json({ message: 'PayMongo payment collection is pending provider activation.' });
    const input = startSubscriptionSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: input.error.issues[0]?.message || 'A valid mobile number is required.' });
    assertPayMongoConfigured();
    const userId = req.user!.userId;
    const selectedPlan = input.data.plan;
    const amountCents = PLAN_CATALOG[selectedPlan].priceCents;
    const remote = await runSubscriptionCheckout({ userId, key: req.get('Idempotency-Key'), provider: 'PAYMONGO', plan: selectedPlan, phone: input.data.phone,
      create: async (attemptId, existing) => {
        if (existing?.provider === 'PAYMONGO' && existing.status === 'ACTIVE' && existing.providerSubscriptionId) {
          return { ...await retrievePayMongoSubscription(existing.providerSubscriptionId), customerId: existing.providerCustomerId!, planId: existing.providerPlanId! };
        }
        const [user, reusablePlan] = await Promise.all([
          prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, email: true } }),
          prisma.subscription.findFirst({ where: { provider: 'PAYMONGO', providerPlanId: { not: null }, requestedPlan: selectedPlan, checkoutAmountCents: amountCents }, select: { providerPlanId: true } }),
        ]);
        const customerId = existing?.providerCustomerId || (await createCustomer(user, input.data.phone)).id;
        const matchingExisting = existing?.requestedPlan === selectedPlan && existing.checkoutAmountCents === amountCents;
        const planId = (matchingExisting ? existing?.providerPlanId : null) || reusablePlan?.providerPlanId || (await createPaidPlan(`casha-ba-${selectedPlan.toLowerCase()}-monthly`, selectedPlan)).id;
        return { ...await createSubscription({ userId, customerId, planId, attemptId }), customerId, planId };
      },
      save: async (tx, result) => {
        const { customerId, planId } = result;
        const period = monthlyPeriod();
        await tx.subscription.upsert({
      where: { userId },
      create: { userId, plan: 'FREE', requestedPlan: selectedPlan, checkoutAmountCents: amountCents, status: 'ACTIVE', provider: 'PAYMONGO', providerCustomerId: customerId, providerSubscriptionId: result.id, providerPlanId: planId, currentPeriodStart: period.periodStart, currentPeriodEnd: period.periodEnd },
      update: { plan: 'FREE', requestedPlan: selectedPlan, checkoutAmountCents: amountCents, status: 'ACTIVE', provider: 'PAYMONGO', providerCustomerId: customerId, providerSubscriptionId: result.id, providerPlanId: planId, currentPeriodStart: period.periodStart, currentPeriodEnd: period.periodEnd, cancelAtPeriodEnd: false, cancelledAt: null },
        });
      },
    });
    res.status(201).json({
      subscription: await getSubscriptionSummary(userId),
      paymentStatus: remote.attributes.status,
      authorizationUrl: remote.attributes.setup_intent?.next_action_url || null,
      message: remote.attributes.setup_intent?.next_action_url ? 'Continue to PayMongo to authorize your first payment.' : 'Subscription created. Complete the first payment in the PayMongo authorization screen.',
    });
  } catch (error) {
    if (!handlePayMongoError(error, res)) throw error;
  }
}

export async function activateDemoPlus(req: Request, res: Response) {
  if (process.env.NODE_ENV === 'production' || (process.env.BILLING_MODE ?? 'demo') !== 'demo') return res.status(404).json({ message: 'Demo billing is unavailable' });
  const input = planSelectionSchema.safeParse(req.body ?? {});
  if (!input.success) return res.status(400).json({ message: 'Choose Basic, Standard or Premium.' });
  const plan = input.data.plan;
  try {
    const now = new Date(); const end = new Date(now); end.setUTCDate(end.getUTCDate() + 30);
    await withFinancialOperation(req.user!.userId, async tx => {
      await assertCheckoutNotProcessing(tx, req.user!.userId);
      const existing = await tx.subscription.findUnique({ where: { userId: req.user!.userId } });
      if (existing && ['PAYMONGO', 'PAYMONGO_TEST'].includes(existing.provider) && existing.providerSubscriptionId && !['CANCELLED', 'EXPIRED'].includes(existing.status)) throw new CheckoutError('Continue or cancel your earlier checkout first.', 'CHECKOUT_ALREADY_PENDING');
      await tx.subscription.upsert({
        where: { userId: req.user!.userId },
        create: { userId: req.user!.userId, plan, requestedPlan: plan, checkoutAmountCents: PLAN_CATALOG[plan].priceCents, status: 'ACTIVE', provider: 'DEMO', currentPeriodStart: now, currentPeriodEnd: end },
        update: { plan, requestedPlan: plan, checkoutAmountCents: PLAN_CATALOG[plan].priceCents, status: 'ACTIVE', provider: 'DEMO', currentPeriodStart: now, currentPeriodEnd: end, cancelAtPeriodEnd: false, cancelledAt: null, providerSubscriptionId: null, providerPlanId: null, providerCustomerId: null },
      });
      return { activated: true };
    }, requestOperation(req));
    res.json(await getSubscriptionSummary(req.user!.userId));
  } catch (error) {
    if (handlePayMongoError(error, res)) return;
    if (error instanceof FinancialError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}

export async function cancelSubscription(req: Request, res: Response) {
  try {
    const userId = req.user!.userId;
    const existing = await prisma.subscription.findUnique({ where: { userId } });
    if (!existing || (!isPaidPlan(existing.plan) && !(['PAYMONGO', 'PAYMONGO_TEST'].includes(existing.provider) && existing.providerSubscriptionId && !['CANCELLED', 'EXPIRED'].includes(existing.status)))) return res.status(409).json({ message: 'There is no active or pending subscription to cancel' });
    if (['PAYMONGO', 'PAYMONGO_TEST'].includes(existing.provider)) {
      await withFinancialOperation(userId, async tx => {
        await assertCheckoutNotProcessing(tx, userId);
        const current = await tx.subscription.findUnique({ where: { userId } });
        if (current?.provider !== existing.provider || current.providerSubscriptionId !== existing.providerSubscriptionId) throw new FinancialError('Your checkout changed. Refresh your plan before cancelling.', 409);
        await cancelCheckout(tx, userId);
      });
    } else {
      await prisma.subscription.update({ where: { userId }, data: { plan: 'FREE', status: 'CANCELLED', cancelAtPeriodEnd: false, cancelledAt: new Date() } });
    }
    res.json(await getSubscriptionSummary(userId));
  } catch (error) {
    if (handlePayMongoError(error, res)) return;
    if (error instanceof FinancialError) return res.status(error.status).json({ message: error.message });
    throw error;
  }
}

export async function billingWebhook(req: Request, res: Response) {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
  if (!verifyPayMongoSignature(rawBody, req.header('paymongo-signature') ?? '')) return res.status(401).json({ message: 'Invalid PayMongo webhook signature' });
  const parsed = payMongoEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Unsupported PayMongo billing event' });
  const event = parsed.data.data;
  if (process.env.NODE_ENV === 'production' && (process.env.BILLING_MODE ?? 'demo') === 'paymongo' && !event.attributes.livemode) {
    return res.status(400).json({ message: 'Test-mode billing events cannot change a live subscription' });
  }
  const resource = event.attributes.data;
  const providerSubscriptionId = resource.type === 'subscription' ? resource.id : resource.attributes.resource_id ?? resource.attributes.subscription?.id;
  if (!providerSubscriptionId) return res.status(400).json({ message: 'Subscription reference is missing' });
  if (await prisma.billingEvent.findUnique({ where: { providerEventId: event.id } })) return res.json({ received: true, duplicate: true });

  const local = await prisma.subscription.findUnique({ where: { providerSubscriptionId } });
  // A signed event for a replaced subscription must not retry or affect the new one.
  if (!local) return res.json({ received: true, ignored: 'Subscription is no longer current' });
  const eventType = event.attributes.type;
  const remoteStatus = resource.attributes.status;
  const active = eventType === 'subscription.invoice.paid' && resource.type === 'invoice' && remoteStatus === 'paid';
  if (active && local.requestedPlan && (resource.attributes.amount !== local.checkoutAmountCents || resource.attributes.currency !== 'PHP' ||
      (resource.attributes.subscription?.plan?.id && resource.attributes.subscription.plan.id !== local.providerPlanId))) {
    return res.status(409).json({ message: 'The paid invoice does not match the selected plan and price.' });
  }
  const pastDue = eventType === 'subscription.past_due' || eventType === 'subscription.invoice.payment_failed';
  const cancelled = eventType === 'subscription.unpaid' || remoteStatus === 'cancelled' || remoteStatus === 'unpaid';
  const status = active ? 'ACTIVE' : pastDue ? 'PAST_DUE' : cancelled ? 'CANCELLED' : local.status;
  const period = nextMonthlyPeriod(resource.attributes.next_billing_schedule);
  const eventSeconds = event.attributes.created_at;
  const eventAt = eventSeconds ? new Date(eventSeconds * 1000) : null;
  const changesState = active || pastDue || cancelled;
  const outcome = await withFinancialOperation(local.userId, async tx => {
    if (await tx.billingEvent.findUnique({ where: { providerEventId: event.id } })) return { received: true, duplicate: true };
    const current = await tx.subscription.findUniqueOrThrow({ where: { id: local.id } });
    if (current.providerSubscriptionId !== providerSubscriptionId || current.status === 'CANCELLED') {
      await tx.billingEvent.create({ data: { providerEventId: event.id, type: eventType, payload: req.body } });
      return { received: true, ignored: 'Subscription is no longer current or was cancelled' };
    }
    const invoiceMarker = `paymongo-paid-invoice:${resource.id}`;
    if (active && await tx.billingEvent.findUnique({ where: { providerEventId: invoiceMarker } })) {
      await tx.billingEvent.create({ data: { providerEventId: event.id, type: eventType, payload: req.body } });
      return { received: true, duplicate: true };
    }
    let applied = false;
    if (changesState && eventAt && !Number.isNaN(eventAt.getTime())) {
      const earlier = await tx.$queryRawUnsafe<Array<{ payload: unknown; type: string }>>(
        `SELECT "payload", "type" FROM ${qualifiedTable('BillingEvent')}
         WHERE "payload" #>> '{data,attributes,data,id}' = $1
            OR "payload" #>> '{data,attributes,data,attributes,resource_id}' = $1
            OR "payload" #>> '{data,attributes,data,attributes,subscription,id}' = $1`, providerSubscriptionId,
      );
      const latestStateEvent = earlier.reduce((latest, row) => {
        const prior = row.payload as { data?: { attributes?: { created_at?: number; data?: { type?: string; attributes?: { status?: string } } } } };
        const timestamp = prior.data?.attributes?.created_at;
        const priorStatus = prior.data?.attributes?.data?.attributes?.status;
        const stateEvent = (row.type === 'subscription.invoice.paid' && prior.data?.attributes?.data?.type === 'invoice' && priorStatus === 'paid') ||
          ['subscription.past_due', 'subscription.invoice.payment_failed', 'subscription.unpaid'].includes(row.type) || ['cancelled', 'unpaid'].includes(priorStatus ?? '');
        return stateEvent && typeof timestamp === 'number' ? Math.max(latest, timestamp) : latest;
      }, 0);
      if (eventSeconds! > latestStateEvent) {
        await tx.subscription.update({
          where: { id: local.id },
          data: {
            plan: active ? (isPaidPlan(current.requestedPlan) ? current.requestedPlan : 'PLUS') : cancelled ? 'FREE' : current.plan,
            status,
            currentPeriodStart: active ? period.periodStart : current.currentPeriodStart,
            currentPeriodEnd: active ? period.periodEnd : current.currentPeriodEnd,
            cancelledAt: cancelled ? new Date() : current.cancelledAt,
          },
        });
        if (active) await tx.billingEvent.create({ data: { providerEventId: invoiceMarker, type: 'subscription.invoice.fulfilled', payload: { invoiceId: resource.id, subscriptionId: providerSubscriptionId } } });
        if (active || cancelled) await closeCheckout(tx, local.userId);
        applied = true;
      }
    }
    await tx.billingEvent.create({ data: { providerEventId: event.id, type: eventType, payload: req.body } });
    return { received: true, applied };
  });
  res.json(outcome);
}
