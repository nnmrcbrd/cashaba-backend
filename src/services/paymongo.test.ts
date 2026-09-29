import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscription } from './paymongo';

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
