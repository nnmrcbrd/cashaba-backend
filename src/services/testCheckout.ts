import { prisma } from '@/lib/prisma';
import { FinancialError, withFinancialOperation } from './financialOperation';
import { createTestPlusCheckout, retrieveTestCheckout, verifiedTestPayment, assertTestCheckoutConfigured } from './paymongo';
import { monthlyPeriod } from './subscription';

export const TEST_CHECKOUT_PROVIDER = 'PAYMONGO_TEST';

// The existing subscription stores the current hosted checkout ID. A durable
// BillingEvent marker makes fulfillment one-time, including after a downgrade.
export async function syncTestCheckout(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  if (subscription?.provider !== TEST_CHECKOUT_PROVIDER || !subscription.providerSubscriptionId || subscription.plan !== 'FREE' || subscription.status !== 'ACTIVE') return;
  const checkout = await retrieveTestCheckout(subscription.providerSubscriptionId);
  const payment = verifiedTestPayment(checkout, userId);
  return withFinancialOperation(userId, async tx => {
    const current = await tx.subscription.findUnique({ where: { userId } });
    if (current?.provider !== TEST_CHECKOUT_PROVIDER || current.providerSubscriptionId !== checkout.id || current.status !== 'ACTIVE' || current.plan !== 'FREE') return;
    const marker = `paymongo-test-checkout:${checkout.id}`;
    if (await tx.billingEvent.findUnique({ where: { providerEventId: marker } })) return;
    if (!payment) {
      if (checkout.attributes.status === 'expired') await tx.subscription.update({ where: { userId }, data: { status: 'EXPIRED' } });
      return;
    }
    const now = new Date();
    const end = new Date(now); end.setUTCDate(end.getUTCDate() + 30);
    await tx.subscription.update({ where: { userId }, data: {
      plan: 'PLUS', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: end,
      cancelAtPeriodEnd: false, cancelledAt: null,
    } });
    await tx.billingEvent.create({ data: {
      providerEventId: marker, type: 'checkout_session.payment.paid',
      payload: { checkoutId: checkout.id, paymentId: payment.id, livemode: false },
    } });
  });
}

export async function startTestCheckout(userId: string) {
  assertTestCheckoutConfigured();
  await syncTestCheckout(userId);
  return withFinancialOperation(userId, async tx => {
    const existing = await tx.subscription.findUnique({ where: { userId } });
    if (existing?.plan === 'PLUS' && existing.status === 'ACTIVE' && existing.currentPeriodEnd > new Date()) throw new FinancialError('Casha-Ba Plus is already active.', 409);
    if (existing?.provider === 'PAYMONGO' && existing.providerSubscriptionId && !['CANCELLED', 'EXPIRED'].includes(existing.status)) throw new FinancialError('Cancel the earlier recurring PayMongo subscription before opening test checkout.', 409);
    if (existing?.provider === TEST_CHECKOUT_PROVIDER && existing.plan === 'FREE' && existing.status === 'ACTIVE' && existing.providerSubscriptionId) {
      return retrieveTestCheckout(existing.providerSubscriptionId);
    }
    const remote = await createTestPlusCheckout({ userId, attempt: `${existing?.providerSubscriptionId ?? 'first'}:${existing?.cancelledAt?.toISOString() ?? ''}` });
    const { periodStart, periodEnd } = monthlyPeriod();
    await tx.subscription.upsert({ where: { userId },
      create: { userId, provider: TEST_CHECKOUT_PROVIDER, providerSubscriptionId: remote.id, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
      update: { provider: TEST_CHECKOUT_PROVIDER, providerSubscriptionId: remote.id, providerCustomerId: null, providerPlanId: null,
        plan: 'FREE', status: 'ACTIVE', currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false, cancelledAt: null },
    });
    return remote;
  });
}
