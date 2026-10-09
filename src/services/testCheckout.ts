import { prisma } from '@/lib/prisma';
import { withFinancialOperation } from './financialOperation';
import { createTestPlanCheckout, retrieveTestCheckout, expireTestCheckout, verifiedTestPayment, assertTestCheckoutConfigured } from './paymongo';
import { monthlyPeriod } from './subscription';
import { PLAN_CATALOG, isPaidPlan, type PaidPlan } from '@/utils/subscriptionPolicy';
import { closeCheckout, runSubscriptionCheckout } from './subscriptionCheckout';

export const TEST_CHECKOUT_PROVIDER = 'PAYMONGO_TEST';

// The existing subscription stores the current hosted checkout ID. A durable
// BillingEvent marker makes fulfillment one-time, including after a downgrade.
export async function syncTestCheckout(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  if (subscription?.provider !== TEST_CHECKOUT_PROVIDER || !subscription.providerSubscriptionId || subscription.plan !== 'FREE' || subscription.status !== 'ACTIVE') return;
  const checkout = await retrieveTestCheckout(subscription.providerSubscriptionId);
  const plan = isPaidPlan(subscription.requestedPlan) ? subscription.requestedPlan : 'PLUS';
  const payment = verifiedTestPayment(checkout, userId, plan, subscription.checkoutAmountCents ?? PLAN_CATALOG[plan].priceCents);
  // Close the paid URL before fulfilling; it must not remain payable later.
  if (payment && checkout.attributes.status !== 'expired') await expireTestCheckout(checkout.id);
  return withFinancialOperation(userId, async tx => {
    const current = await tx.subscription.findUnique({ where: { userId } });
    if (current?.provider !== TEST_CHECKOUT_PROVIDER || current.providerSubscriptionId !== checkout.id || current.status !== 'ACTIVE' || current.plan !== 'FREE') return;
    const marker = `paymongo-test-checkout:${checkout.id}`;
    if (await tx.billingEvent.findUnique({ where: { providerEventId: marker } })) return;
    if (!payment) {
      if (checkout.attributes.status === 'expired') {
        await tx.subscription.update({ where: { userId }, data: { status: 'EXPIRED' } });
        await closeCheckout(tx, userId);
      }
      return;
    }
    const now = new Date();
    const end = new Date(now); end.setUTCDate(end.getUTCDate() + 30);
    await tx.subscription.update({ where: { userId }, data: {
      plan, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: end,
      cancelAtPeriodEnd: false, cancelledAt: null,
    } });
    await tx.billingEvent.create({ data: {
      providerEventId: marker, type: 'checkout_session.payment.paid',
      payload: { checkoutId: checkout.id, paymentId: payment.id, livemode: false },
    } });
    await closeCheckout(tx, userId);
  });
}

export async function startTestCheckout(userId: string, plan: PaidPlan = 'BASIC', key?: string) {
  assertTestCheckoutConfigured();
  await syncTestCheckout(userId);
  return runSubscriptionCheckout({ userId, plan, provider: TEST_CHECKOUT_PROVIDER, key,
    create: (attemptId, existing) => existing?.provider === TEST_CHECKOUT_PROVIDER && existing.plan === 'FREE' && existing.status === 'ACTIVE' && existing.providerSubscriptionId
      ? retrieveTestCheckout(existing.providerSubscriptionId)
      : createTestPlanCheckout({ userId, plan, attempt: attemptId }),
    save: async (tx, remote) => {
    const { periodStart, periodEnd } = monthlyPeriod();
    await tx.subscription.upsert({ where: { userId },
      create: { userId, provider: TEST_CHECKOUT_PROVIDER, providerSubscriptionId: remote.id, requestedPlan: plan, checkoutAmountCents: PLAN_CATALOG[plan].priceCents, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
      update: { provider: TEST_CHECKOUT_PROVIDER, providerSubscriptionId: remote.id, providerCustomerId: null, providerPlanId: null,
        plan: 'FREE', requestedPlan: plan, checkoutAmountCents: PLAN_CATALOG[plan].priceCents, status: 'ACTIVE', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false, cancelledAt: null },
    });
    },
  });
}
