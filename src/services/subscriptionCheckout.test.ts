import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelCheckout } from './subscriptionCheckout';
import type { FinancialTx } from './financialOperation';

test('cancellation distinguishes fulfilled test access from an unpaid checkout and recurring billing', async t => {
  const originalMode = process.env.BILLING_MODE;
  const originalKey = process.env.PAYMONGO_SECRET_KEY;
  process.env.BILLING_MODE = 'paymongo_test';
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_cancellation_fixture';
  t.after(() => {
    if (originalMode === undefined) delete process.env.BILLING_MODE; else process.env.BILLING_MODE = originalMode;
    if (originalKey === undefined) delete process.env.PAYMONGO_SECRET_KEY; else process.env.PAYMONGO_SECRET_KEY = originalKey;
  });

  for (const scenario of [
    { name: 'fulfilled legacy Plus', plan: 'PLUS', provider: 'PAYMONGO_TEST', remote: [] },
    { name: 'fulfilled Basic', plan: 'BASIC', provider: 'PAYMONGO_TEST', remote: [] },
    { name: 'unpaid test checkout', plan: 'FREE', provider: 'PAYMONGO_TEST', remote: ['GET', 'POST'] },
    { name: 'recurring subscription', plan: 'STANDARD', provider: 'PAYMONGO', remote: ['DELETE'] },
    { name: 'failed pending checkout closure', plan: 'FREE', provider: 'PAYMONGO_TEST', remote: ['GET', 'POST'], fails: true },
  ]) {
    await t.test(scenario.name, async child => {
      let subscription = { userId: 'fixture', plan: scenario.plan, provider: scenario.provider, status: 'ACTIVE', providerSubscriptionId: 'cs_fixture' };
      const calls: string[] = [];
      const journal = { state: 'READY', attemptId: 'attempt', operationKey: 'request:fixture', provider: scenario.provider, plan: 'PLUS' };
      let closed = false;
      const tx = {
        subscription: {
          findUnique: async () => subscription,
          update: async ({ data }: { data: Partial<typeof subscription> }) => { subscription = { ...subscription, ...data }; },
        },
        financialOperation: {
          findUnique: async () => ({ id: 'journal', result: journal }),
          update: async ({ data }: { data: { result: { state: string } } }) => { closed = data.result.state === 'CLOSED'; },
          updateMany: async () => ({}),
        },
      } as unknown as FinancialTx;
      child.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push(method);
        if (method === 'POST' && scenario.fails) return Response.json({ errors: [{ detail: 'Checkout closure unavailable' }] }, { status: 500 });
        if (method === 'POST' && scenario.plan !== 'FREE') return Response.json({ errors: [{ detail: 'Checkout session is already paid' }] }, { status: 400 });
        return Response.json({ data: { id: 'cs_fixture', type: 'checkout_session', attributes: {
          checkout_url: 'https://checkout.paymongo.com/cs_fixture', livemode: false,
          status: method === 'POST' ? 'expired' : 'active',
        } } });
      });
      if (scenario.fails) {
        await assert.rejects(cancelCheckout(tx, 'fixture'), /closure unavailable/);
        assert.equal(subscription.status, 'ACTIVE');
        assert.equal(closed, false);
      } else {
        await cancelCheckout(tx, 'fixture');
        assert.equal(subscription.plan, 'FREE');
        assert.equal(subscription.status, 'CANCELLED');
        assert.equal(closed, true);
      }
      assert.deepEqual(calls, scenario.remote);
    });
  }
});
