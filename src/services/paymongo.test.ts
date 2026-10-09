import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscription, createTestPlusCheckout, createTestPlanCheckout, createPaidPlan, verifiedTestPayment, type PayMongoCheckout } from './paymongo';
import { PLAN_CATALOG } from '@/utils/subscriptionPolicy';

test('a new subscription after cancellation gets a new provider retry key', async () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.PAYMONGO_SECRET_KEY;
  const keys: Array<string | null> = [];
  try {
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_example';
    globalThis.fetch = async (_input, init) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key'));
      return Response.json({ data: { id: 'sub-example', type: 'subscription', attributes: { customer_id: 'customer', status: 'pending' } } });
    };
    const first = { userId: 'user', customerId: 'customer', planId: 'plan' };
    await createSubscription(first);
    await createSubscription(first);
    await createSubscription({ ...first, previousSubscriptionId: 'sub-example' });
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.PAYMONGO_SECRET_KEY;
    else process.env.PAYMONGO_SECRET_KEY = originalSecret;
  }
});

test('hosted test checkout rejects live keys before making a request and sets return URLs', async () => {
  const originalFetch = globalThis.fetch;
  const names = ['PAYMONGO_SECRET_KEY', 'BILLING_MODE', 'FRONTEND_URL'] as const;
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let calls = 0;
  try {
    process.env.BILLING_MODE = 'paymongo_test';
    process.env.PAYMONGO_SECRET_KEY = 'sk_live_example';
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://api.paymongo.com/v2/checkout_sessions');
      const attributes = JSON.parse(String(init?.body)).data.attributes;
      assert.equal(attributes.success_url, 'http://localhost:3000/subscription?payment=success');
      assert.equal(attributes.cancel_url, 'http://localhost:3000/subscription?payment=cancelled');
      assert.deepEqual(attributes.line_items, [{ name: 'Casha-Ba Plus — 30 days', amount: 9900, currency: 'PHP', quantity: 1 }]);
      return Response.json({ data: { id: 'cs_test', attributes: { ...attributes, livemode: false, checkout_url: 'https://checkout.paymongo.com/cs_test' } } });
    };
    await assert.rejects(createTestPlusCheckout({ userId: 'owner', attempt: 'first' }), /secret test key/);
    assert.equal(calls, 0);
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_example';
    process.env.FRONTEND_URL = 'http://localhost:3000';
    await createTestPlusCheckout({ userId: 'owner', attempt: 'first' });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
  }
});

test('Plus fulfillment requires an owned, correctly priced, paid TEST payment', () => {
  const checkout: PayMongoCheckout = { id: 'cs_test', type: 'checkout_session', attributes: {
    checkout_url: 'https://checkout.paymongo.com/cs_test', livemode: false, status: 'active', reference_number: 'owner',
    metadata: { casha_ba_user_id: 'owner', product: 'casha-ba-plus-test' },
    line_items: [{ amount: 9900, currency: 'PHP', quantity: 1 }], payments: [],
  } };
  assert.equal(verifiedTestPayment(checkout, 'owner'), null);
  assert.throws(() => verifiedTestPayment(checkout, 'another-user'), /does not belong/);
  checkout.attributes.payments = [{ id: 'pay_test', type: 'payment', attributes: { status: 'paid', amount: 9900, currency: 'PHP', livemode: false } }];
  assert.equal(verifiedTestPayment(checkout, 'owner')?.id, 'pay_test');
  checkout.attributes.payments[0]!.attributes.livemode = true;
  assert.equal(verifiedTestPayment(checkout, 'owner'), null);
  checkout.attributes.payments[0]!.attributes.livemode = false;
  checkout.attributes.payments[0]!.attributes.amount = 1;
  assert.equal(verifiedTestPayment(checkout, 'owner'), null);
  checkout.attributes.line_items[0]!.currency = 'USD';
  assert.throws(() => verifiedTestPayment(checkout, 'owner'), /amount does not match/);
});

test('every tier sends its own amount, metadata and provider retry key and rejects mismatched payments', async t => {
  const env = { key: process.env.PAYMONGO_SECRET_KEY, mode: process.env.BILLING_MODE };
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_example'; process.env.BILLING_MODE = 'paymongo_test';
  t.after(() => {
    if (env.key === undefined) delete process.env.PAYMONGO_SECRET_KEY; else process.env.PAYMONGO_SECRET_KEY = env.key;
    if (env.mode === undefined) delete process.env.BILLING_MODE; else process.env.BILLING_MODE = env.mode;
  });
  const keys = new Set<string>();
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    const attrs = JSON.parse(String(init?.body)).data.attributes;
    keys.add(new Headers(init?.headers).get('Idempotency-Key')!);
    assert.equal(attrs.line_items?.[0]?.amount ?? attrs.amount, PLAN_CATALOG[attrs.metadata.plan as keyof typeof PLAN_CATALOG].priceCents);
    return Response.json({ data: { id: 'test', type: 'checkout_session', attributes: { ...attrs, livemode: false, status: 'active', checkout_url: 'https://checkout.paymongo.com/test' } } });
  });
  for (const plan of ['BASIC', 'STANDARD', 'PREMIUM'] as const) {
    const checkout = await createTestPlanCheckout({ userId: 'owner', attempt: 'first', plan });
    await createPaidPlan('monthly', plan);
    const amount = PLAN_CATALOG[plan].priceCents;
    checkout.attributes.payments = [{ id: 'paid', type: 'payment', attributes: { status: 'paid', amount, currency: 'PHP', livemode: false } }];
    assert.equal(verifiedTestPayment(checkout, 'owner', plan, amount)?.id, 'paid');
    assert.throws(() => verifiedTestPayment(checkout, 'owner', plan, amount - 100), /amount does not match/);
    checkout.attributes.metadata!.plan = plan === 'BASIC' ? 'PREMIUM' : 'BASIC';
    assert.throws(() => verifiedTestPayment(checkout, 'owner', plan, amount), /does not belong/);
  }
  assert.equal(keys.size, 6, 'each tier and endpoint uses a distinct key');
});
