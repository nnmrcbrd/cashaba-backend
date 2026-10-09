import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import type { PayMongoCheckout } from '../src/services/paymongo';

test('subscription idempotency against isolated PostgreSQL and mocked PayMongo', { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 }, async t => {
  const schema = 'casha_test_' + randomUUID().replaceAll('-', '');
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  await db.query((await readFile(new URL('../prisma/fresh-baseline.sql', import.meta.url), 'utf8')).replace(/CREATE SCHEMA IF NOT EXISTS "public";/g, '').replaceAll('"public".', `"${schema}".`));
  await db.query('ALTER TABLE "AiSession" ADD COLUMN IF NOT EXISTS "context_metadata" JSONB');
  process.env.TEST_DATABASE_SCHEMA = schema;
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_idempotency_fixture';
  process.env.PAYMONGO_WEBHOOK_SECRET = 'idempotency-fixture';
  delete process.env.GEMINI_API_KEY;
  const { prisma } = await import('../src/lib/prisma');
  const { default: app } = await import('../src/app');
  const { loginUser } = await import('../src/services/auth');
  const { runSubscriptionCheckout } = await import('../src/services/subscriptionCheckout');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.$disconnect();
    await db.query('SET search_path TO public');
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  const password = await bcrypt.hash('Idempotency123!', 4);
  async function fixture() {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, password, firstName: 'Checkout', lastName: 'Test', roles: [], emailVerified: new Date(), localCredentialVerified: true } });
    return { user, token: (await loginUser({ email: user.email, password: 'Idempotency123!' })).accessToken };
  }
  const checkoutPath = '/subscriptions/paymongo/test/checkout';
  async function api(token: string, path: string, body?: unknown, key = randomUUID()) {
    const response = await originalFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json() as { checkoutUrl?: string; code?: string; checkoutState?: string; plan?: string; duplicate?: boolean; applied?: boolean };
    return { status: response.status, body: result };
  }
  const sessions = new Map<string, PayMongoCheckout>();
  let creations = 0, ambiguous = false, expiryFails = false;
  let onCreate: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.paymongo.com/v2/checkout_sessions') {
      const attrs = JSON.parse(String(init?.body)).data.attributes;
      const id = `cs_safe_${++creations}`;
      sessions.set(id, { id, type: 'checkout_session', attributes: { ...attrs, status: 'active', livemode: false, checkout_url: `https://checkout.paymongo.com/${id}`, payments: [] } });
      if (onCreate) await onCreate();
      if (ambiguous) throw new Error('Provider created the checkout, then the connection was lost');
      return Response.json({ data: sessions.get(id) });
    }
    if (url.startsWith('https://api.paymongo.com/v1/checkout_sessions/')) {
      const session = sessions.get(url.split('/')[5]!)!;
      if (url.endsWith('/expire')) {
        if (expiryFails) return Response.json({ errors: [{ code: 'provider_busy' }] }, { status: 500 });
        session.attributes.status = 'expired';
      }
      return Response.json({ data: session });
    }
    assert.ok(!url.startsWith('https://api.paymongo.com'), 'Provider traffic must be mocked');
    return originalFetch(input, init);
  };
  process.env.BILLING_MODE = 'paymongo_test';

  await t.test('concurrent requests reserve one checkout, replay the same URL and reject changed payloads', async () => {
    const f = await fixture(), key = randomUUID();
    const before = creations;
    let entered!: () => void, release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    onCreate = async () => { entered(); await releaseGate; };
    const first = api(f.token, checkoutPath, { plan: 'STANDARD' }, key);
    try {
      await enteredGate;
      const second = await api(f.token, checkoutPath, { plan: 'STANDARD' }, key);
      assert.equal(second.status, 409); assert.equal(second.body.code, 'CHECKOUT_IN_PROGRESS');
    } finally { release(); onCreate = undefined; }
    const accepted = await first;
    assert.equal(accepted.status, 201);
    assert.equal((await api(f.token, checkoutPath, { plan: 'STANDARD' }, key)).body.checkoutUrl, accepted.body.checkoutUrl, 'lost browser response uses original URL');
    assert.equal((await api(f.token, checkoutPath, { plan: 'STANDARD' })).body.checkoutUrl, accepted.body.checkoutUrl, 'a new tab cannot create another checkout');
    const changed = await api(f.token, checkoutPath, { plan: 'PREMIUM' }, key);
    assert.equal(changed.status, 409); assert.equal(changed.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(creations - before, 1);
    const other = await fixture();
    assert.equal((await api(other.token, checkoutPath, { plan: 'STANDARD' }, key)).status, 201, 'retry keys are scoped to authenticated users');
    assert.equal(creations - before, 2);
  });
  await t.test('an ambiguous provider timeout stays reserved across new request keys', async () => {
    const f = await fixture(), before = creations;
    ambiguous = true;
    try { assert.equal((await api(f.token, checkoutPath, { plan: 'BASIC' })).status, 502); }
    finally { ambiguous = false; }
    assert.equal((await api(f.token, '/subscriptions/me')).body.checkoutState, 'UNCERTAIN');
    assert.equal((await api(f.token, checkoutPath, { plan: 'BASIC' })).status, 409);
    assert.equal((await api(f.token, checkoutPath, { plan: 'PREMIUM' })).status, 409);
    assert.equal(creations - before, 1, 'unknown results never open another payable session');
    assert.equal(await prisma.financialOperation.count({ where: { userId: f.user.id, key: { startsWith: 'billing:checkout:' } } }), 2, 'reservation is stored in the DB');
  });
  await t.test('a known provider result survives a local save failure and finalizes without another POST', async () => {
    const f = await fixture(), key = randomUUID();
    let creates = 0, saves = 0;
    const options = { userId: f.user.id, key, provider: 'PAYMONGO_TEST' as const, plan: 'BASIC' as const,
      create: async () => { creates++; return { id: 'known_remote' }; },
      save: async () => { if (++saves === 1) throw new Error('Temporary DB write failed'); },
    };
    await assert.rejects(runSubscriptionCheckout(options), /DB write failed/);
    assert.equal((await api(f.token, '/subscriptions/me')).body.checkoutState, 'UNCERTAIN');
    assert.equal((await runSubscriptionCheckout(options)).id, 'known_remote');
    assert.equal(creates, 1); assert.equal(saves, 2);
  });
  await t.test('a different plan cannot replace the first checkout until provider expiration succeeds', async () => {
    const f = await fixture(), key = randomUUID(), before = creations;
    assert.equal((await api(f.token, checkoutPath, { plan: 'BASIC' }, key)).status, 201);
    const current = await prisma.subscription.findUniqueOrThrow({ where: { userId: f.user.id } });
    assert.equal((await api(f.token, checkoutPath, { plan: 'PREMIUM' })).status, 409);
    expiryFails = true;
    try { assert.equal((await api(f.token, '/subscriptions/cancel', {})).status, 502); }
    finally { expiryFails = false; }
    assert.equal((await api(f.token, checkoutPath, { plan: 'PREMIUM' })).status, 409);
    assert.equal(creations - before, 1);
    assert.equal((await api(f.token, '/subscriptions/cancel', {})).status, 200);
    assert.equal(sessions.get(current.providerSubscriptionId!)!.attributes.status, 'expired');
    assert.equal((await api(f.token, checkoutPath, { plan: 'BASIC' }, key)).status, 409, 'an old retry key cannot reopen a cancelled checkout');
    assert.equal((await api(f.token, checkoutPath, { plan: 'PREMIUM' })).status, 201);
    assert.equal(creations - before, 2);
  });
  await t.test('live recurring creation is serialized and duplicate paid invoices fulfill once', async () => {
    process.env.BILLING_MODE = 'paymongo';
    const f = await fixture(), key = randomUUID();
    let subscriptionPosts = 0;
    let entered!: () => void, release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.paymongo.com/v1/customers') return Response.json({ data: { id: 'customer_live_fixture', attributes: {} } });
      if (url === 'https://api.paymongo.com/v1/subscriptions/plans') return Response.json({ data: { id: 'plan_live_fixture', attributes: {} } });
      if (url === 'https://api.paymongo.com/v1/subscriptions') {
        subscriptionPosts++; entered(); await gate;
        assert.ok(new Headers(init?.headers).get('Idempotency-Key'));
        return Response.json({ data: { id: 'subscription_live_fixture', attributes: { status: 'pending', customer_id: 'customer_live_fixture', setup_intent: { next_action_url: 'https://payments.paymongo.com/authorize' } } } });
      }
      assert.ok(!url.startsWith('https://api.paymongo.com'));
      return originalFetch(input, init);
    };
    const input = { plan: 'BASIC', phone: '+639171234567' };
    const first = api(f.token, '/subscriptions/paymongo/start', input, key);
    try { await enteredGate; assert.equal((await api(f.token, '/subscriptions/paymongo/start', input, key)).status, 409); }
    finally { release(); }
    assert.equal((await first).status, 201);
    assert.equal((await api(f.token, '/subscriptions/paymongo/start', input, key)).status, 201);
    assert.equal(subscriptionPosts, 1);
    const now = Math.floor(Date.now() / 1000);
    const event = { data: { id: `evt_${randomUUID()}`, attributes: { type: 'subscription.invoice.paid', livemode: false, created_at: now,
      data: { id: 'invoice_once_fixture', type: 'invoice', attributes: { status: 'paid', amount: 9900, currency: 'PHP', subscription: { id: 'subscription_live_fixture', plan: { id: 'plan_live_fixture' } } } } } } };
    async function webhook(value: unknown) {
      const raw = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(timestamp + '.').update(raw).digest('hex');
      const response = await originalFetch(base + '/subscriptions/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'paymongo-signature': `t=${timestamp},te=${signature}` }, body: raw });
      return { status: response.status, body: await response.json() as { applied?: boolean; duplicate?: boolean } };
    }
    const callbacks = await Promise.all([webhook(event), webhook(event)]);
    assert.ok(callbacks.every(result => result.status === 200));
    assert.equal(callbacks.filter(result => result.body.applied).length, 1);
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { userId: f.user.id } });
    event.data.id = `evt_${randomUUID()}`; event.data.attributes.created_at = now + 1;
    assert.equal((await webhook(event)).body.duplicate, true, 'a second event ID for the same invoice is also deduplicated');
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { userId: f.user.id } })).currentPeriodEnd.getTime(), paid.currentPeriodEnd.getTime());
    assert.equal(await prisma.billingEvent.count({ where: { providerEventId: 'paymongo-paid-invoice:invoice_once_fixture' } }), 1);
  });
});
