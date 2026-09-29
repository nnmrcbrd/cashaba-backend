import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';

// Require an explicit test database. Every object and test user additionally
// lives in a random isolated schema. No application schema is queried.
const connectionString = process.env.TEST_DATABASE_URL || (process.env.ALLOW_ISOLATED_SCHEMA_TESTS === 'true' ? process.env.DATABASE_URL : undefined);
test('PostgreSQL API and financial integration regressions', { skip: !connectionString, timeout: 240_000 }, async t => {
  const schema = 'casha_test_' + randomUUID().replaceAll('-', '');
  assert.match(schema, /^casha_test_[a-f0-9]{32}$/);
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    await admin.query('SET search_path TO public');
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await admin.query(`SET search_path TO "${schema}"`);
  const baseline = (await readFile(new URL('../prisma/fresh-baseline.sql', import.meta.url), 'utf8'))
    .replace(/CREATE SCHEMA IF NOT EXISTS "public";/g, '')
    .replaceAll('"public".', `"${schema}".`);
  await admin.query(baseline);
  // Exercise the additive migration against the preceding shape, with a legacy
  // user present, instead of only testing a freshly generated schema.
  await admin.query('DROP TABLE "FinancialOperation"; ALTER TABLE "User" DROP COLUMN "local_credential_verified", DROP COLUMN "google_subject", DROP COLUMN "session_version"; ALTER TABLE "Loan" DROP COLUMN "schedule_anchor"; ALTER TABLE "FixedExpense" DROP COLUMN "schedule_anchor"; ALTER TABLE "Wallet" DROP COLUMN "custom_type"; ALTER TABLE "Subscription" DROP COLUMN "provider_plan_id";');
  await admin.query('INSERT INTO "User" (id, email, password, "firstName", "lastName", "updatedAt", "email_verified") VALUES ($1,$2,$3,$4,$5,NOW(),NOW())', ['legacy', 'legacy@example.test', 'untrusted-hash', 'Legacy', 'User']);
  await admin.query(await readFile(new URL('../prisma/migrations/20260925000000_secure_financial_operations/migration.sql', import.meta.url), 'utf8'));
  assert.equal((await admin.query('SELECT "local_credential_verified" FROM "User" WHERE id=$1', ['legacy'])).rows[0].local_credential_verified, false);
  await admin.query(await readFile(new URL('../prisma/migrations/20260926000000_add_wallet_custom_type/migration.sql', import.meta.url), 'utf8'));
  assert.ok((await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='Wallet' AND column_name='custom_type'", [schema])).rows.length);
  await admin.query(await readFile(new URL('../prisma/migrations/20260928180000_add_paymongo_plan_id/migration.sql', import.meta.url), 'utf8'));
  assert.ok((await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='Subscription' AND column_name='provider_plan_id'", [schema])).rows.length);

  process.env.TEST_DATABASE_URL = connectionString!;
  process.env.TEST_DATABASE_SCHEMA = schema;
  process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
  delete process.env.GEMINI_API_KEY;
  const { prisma } = await import('../src/lib/prisma');
  const { default: app } = await import('../src/app');
  const { withFinancialOperation } = await import('../src/services/financialOperation');
  const { recordMovement, reverseMovement } = await import('../src/services/movements');
  const auth = await import('../src/services/auth');
  const { calculateSafeToSpend } = await import('../src/utils/safeToSpend');
  const { consumeUsage, refundUsage, getSubscriptionSummary } = await import('../src/services/subscription');
  const { confirmAiAction } = await import('../src/controllers/aiCommand.controller');
  const { importStatement } = await import('../src/services/statementImport');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  });
  const password = 'Integration123!';
  const hashed = await bcrypt.hash(password, 4);
  async function fixture() {
    const user = await prisma.user.create({ data: { email: randomUUID() + '@example.test', password: hashed, firstName: 'Integration', lastName: 'Test', roles: [], emailVerified: new Date(), localCredentialVerified: true } });
    const wallet = await prisma.wallet.create({ data: { userId: user.id, name: 'Cash', openingBalance: 10_000, kind: 'ASSET' } });
    const login = await auth.loginUser({ email: user.email, password });
    return { user, wallet, token: login.accessToken };
  }
  async function api(token: string, path: string, method = 'GET', body?: unknown, retryKey?: string) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(retryKey ? { 'Idempotency-Key': retryKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json() as Array<{ balance: number }> & {
      id?: string; expense?: { id: string; dueDate: string | null }; breakdown?: { savings: number; spending: number; debt: number };
      budget?: { target: number }; configured?: boolean; customType?: string; targetAmount?: number; safeToSpend?: number;
      setup?: { totalIncome: number }; plan?: string; cancelAtPeriodEnd?: boolean; paymentPending?: boolean; limits?: { aiRequests: number; receiptScans: number };
      summary?: { totalIncome: number; loanCollections: number; netCashFlow: number };
    };
    return { status: response.status, body: result };
  }

  await t.test('RBAC separates user finance access from administrator access', async () => {
    const regular = await fixture();
    const adminUser = await prisma.user.create({ data: { email: randomUUID() + '@example.test', password: hashed, firstName: 'Admin', lastName: 'Test', accountRole: 'ADMIN', roles: [], emailVerified: new Date(), localCredentialVerified: true } });
    const secondAdmin = await prisma.user.create({ data: { email: randomUUID() + '@example.test', password: hashed, firstName: 'Second', lastName: 'Admin', accountRole: 'ADMIN', roles: [], emailVerified: new Date(), localCredentialVerified: true } });
    const adminLogin = await auth.loginUser({ email: adminUser.email, password });

    assert.equal((await api(regular.token, '/users/admin/manage-users')).status, 403);
    assert.equal((await api(adminLogin.accessToken, '/wallets')).status, 403);
    assert.equal((await api(adminLogin.accessToken, '/users/admin/manage-users')).status, 200);
    assert.equal((await api(adminLogin.accessToken, `/users/admin/users/${secondAdmin.id}/status`, 'PATCH', { status: 'SUSPENDED' })).status, 403);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: secondAdmin.id } })).accountStatus, 'ACTIVE');
  });

  await t.test('ownership, type/link validation and durable HTTP idempotency', async () => {
    const a = await fixture(), b = await fixture();
    assert.equal((await api(a.token, '/wallets', 'POST', { name: 'Custom', accountType: 'OTHER', kind: 'ASSET', openingBalance: 0 })).status, 400);
    const customWallet = await api(a.token, '/wallets', 'POST', { name: 'Custom', accountType: 'OTHER', customType: 'Cooperative', kind: 'ASSET', openingBalance: 0 });
    assert.equal(customWallet.status, 201);
    assert.equal(customWallet.body.customType, 'Cooperative');
    const bill = await prisma.fixedExpense.create({ data: { userId: a.user.id, name: 'Bill', amount: 100, frequency: 'ONE_TIME' } });
    assert.equal((await api(a.token, `/income-setup/fixed-expenses/${bill.id}`, 'PATCH', { walletId: b.wallet.id })).status, 400);
    assert.equal((await prisma.fixedExpense.findUniqueOrThrow({ where: { id: bill.id } })).walletId, null);
    const input = { type: 'INCOME', category: 'Salary', description: 'Salary', amount: 100, date: '2026-09-25', walletId: a.wallet.id };
    assert.equal((await api(a.token, '/transactions', 'POST', { ...input, fixedExpenseId: bill.id })).status, 400);
    assert.equal((await api(a.token, '/transactions', 'POST', { ...input, walletId: b.wallet.id })).status, 400);
    const key = randomUUID();
    const results = await Promise.all([api(a.token, '/transactions', 'POST', input, key), api(a.token, '/transactions', 'POST', input, key)]);
    assert.deepEqual(results.map(result => result.status), [201, 201]);
    assert.equal(results[0].body.id, results[1].body.id);
    assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 1);
    assert.equal((await api(a.token, '/transactions', 'POST', { ...input, amount: 200 }, key)).status, 409);
  });
  await t.test('concurrent savings writes, non-latest deletion, repeated deletion and insufficient reversal', async () => {
    const f = await fixture();
    const goal = await prisma.savingsGoal.create({ data: { userId: f.user.id, name: 'Goal', targetAmount: 1000 } });
    const contribute = (amount: number) => withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'SAVINGS_CONTRIBUTION', savingsGoalId: goal.id, walletId: f.wallet.id, description: 'Save', category: 'Savings', amount, date: new Date() }));
    const first = await contribute(100);
    await Promise.all([contribute(100), contribute(100)]);
    assert.equal(Number((await prisma.savingsGoal.findUniqueOrThrow({ where: { id: goal.id } })).currentAmount), 300);
    await withFinancialOperation(f.user.id, tx => reverseMovement(tx, f.user.id, first.id));
    await withFinancialOperation(f.user.id, tx => reverseMovement(tx, f.user.id, first.id));
    assert.equal(Number((await prisma.savingsGoal.findUniqueOrThrow({ where: { id: goal.id } })).currentAmount), 200);
    assert.equal((await api(f.token, `/income-setup/savings-goals/${goal.id}`, 'DELETE')).status, 409);
    const attempts = await Promise.allSettled([1, 2].map(() => withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'SAVINGS_WITHDRAWAL', savingsGoalId: goal.id, walletId: f.wallet.id, description: 'Withdraw', category: 'Savings', amount: 150, date: new Date() }))));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(Number((await prisma.savingsGoal.findUniqueOrThrow({ where: { id: goal.id } })).currentAmount), 50);
    const activeContribution = await prisma.transaction.findFirstOrThrow({ where: { savingsGoalId: goal.id, deletedAt: null, type: 'SAVINGS_CONTRIBUTION' } });
    await assert.rejects(() => withFinancialOperation(f.user.id, tx => reverseMovement(tx, f.user.id, activeContribution.id)));
  });
  await t.test('loan concurrency, month-end anchor and reversing an older installment', async () => {
    const f = await fixture();
    const loan = await prisma.loan.create({ data: { userId: f.user.id, title: 'Loan', amount: 500, amountPaid: 0, repaymentAmount: 100, repaymentFrequency: 'MONTHLY', type: 'BORROWED', status: 'ACTIVE', startDate: new Date(2026, 0, 1), deadline: new Date(2026, 0, 31, 12) } });
    const pay = () => withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'DEBT_PAYMENT', loanId: loan.id, walletId: f.wallet.id, description: 'Pay', category: 'Debt', amount: 100, date: new Date() }));
    const first = await pay();
    assert.equal((await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } })).deadline.getMonth(), 1);
    await Promise.all([pay(), pay()]);
    let result = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    assert.equal(Number(result.amountPaid), 300);
    assert.equal(result.deadline.getMonth(), 3);
    assert.equal(result.deadline.getDate(), 30);
    await withFinancialOperation(f.user.id, tx => reverseMovement(tx, f.user.id, first.id));
    result = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    assert.equal(Number(result.amountPaid), 200);
    assert.equal(result.deadline.getMonth(), 2);
    assert.equal(result.deadline.getDate(), 31);
    assert.equal((await api(f.token, `/loans/${loan.id}`, 'DELETE')).status, 409);
  });
  await t.test('loan principal changes an asset wallet exactly once', async () => {
    const f = await fixture();
    const borrowed = await api(f.token, '/loans', 'POST', { title: 'Emergency loan', amount: 500, type: 'BORROWED', deadline: '2026-12-31', repaymentAmount: 100, repaymentFrequency: 'MONTHLY', walletId: f.wallet.id });
    assert.equal(borrowed.status, 201);
    const principal = await prisma.transaction.findFirstOrThrow({ where: { loanId: borrowed.body.id, type: 'LOAN_PROCEEDS' } });
    assert.equal(Number(principal.amount), 500);
    let wallets = await api(f.token, '/wallets');
    assert.equal(wallets.body[0].balance, 10_500);
    assert.equal((await api(f.token, `/transactions/${principal.id}`, 'DELETE')).status, 409);
    assert.equal((await api(f.token, `/loans/${borrowed.body.id}`, 'DELETE')).status, 200);
    wallets = await api(f.token, '/wallets');
    assert.equal(wallets.body[0].balance, 10_000);
    const lent = await api(f.token, '/loans', 'POST', { title: 'Friend', amount: 250, type: 'LENT', deadline: '2026-12-31', repaymentAmount: 250, repaymentFrequency: 'ONE_TIME', walletId: f.wallet.id });
    assert.equal(lent.status, 201);
    wallets = await api(f.token, '/wallets');
    assert.equal(wallets.body[0].balance, 9_750);
    const existingDebt = await api(f.token, '/loans', 'POST', { title: 'Already in opening balance', amount: 300, type: 'BORROWED', deadline: '2026-12-31', repaymentAmount: 300, repaymentFrequency: 'ONE_TIME', principalAlreadyIncluded: true });
    assert.equal(existingDebt.status, 201);
    assert.equal(await prisma.transaction.count({ where: { loanId: existingDebt.body.id } }), 0);
    wallets = await api(f.token, '/wallets');
    assert.equal(wallets.body[0].balance, 9_750);
  });
  await t.test('Free and Plus entitlements report limits and support the capstone activation flow', async () => {
    const f = await fixture();
    process.env.BILLING_MODE = 'demo';
    const free = await api(f.token, '/subscriptions/me');
    assert.equal(free.status, 200);
    assert.equal(free.body.plan, 'FREE');
    assert.equal(free.body.limits.aiRequests, 10);
    assert.equal((await api(f.token, '/subscriptions/paymongo/start', 'POST', { phone: '+639171234567' })).status, 503);
    const plus = await api(f.token, '/subscriptions/demo/activate', 'POST', {});
    assert.equal(plus.status, 200);
    assert.equal(plus.body.plan, 'PLUS');
    assert.equal(plus.body.limits.receiptScans, 100);
    const cancelled = await api(f.token, '/subscriptions/cancel', 'POST', {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancelAtPeriodEnd, true);
  });
  await t.test('a failed scan can restore its reserved monthly quota', async () => {
    const f = await fixture();
    const usage = await consumeUsage(f.user.id, 'receiptScans');
    assert.equal((await getSubscriptionSummary(f.user.id)).used.receiptScans, 1);
    await refundUsage(f.user.id, 'receiptScans', usage.id);
    assert.equal((await getSubscriptionSummary(f.user.id)).used.receiptScans, 0);
  });
  await t.test('loan principal collection is cash received but not earned income', async () => {
    const f = await fixture();
    const loan = await prisma.loan.create({ data: { userId: f.user.id, title: 'Money lent', amount: 500, type: 'LENT', status: 'ACTIVE', startDate: new Date(), deadline: new Date(Date.now() + 86_400_000) } });
    await prisma.transaction.create({ data: { userId: f.user.id, walletId: f.wallet.id, type: 'INCOME', category: 'Salary', description: 'Pay', amount: 200, date: new Date() } });
    await prisma.transaction.create({ data: { userId: f.user.id, walletId: f.wallet.id, loanId: loan.id, type: 'LOAN_COLLECTION', category: 'Loan Collection', description: 'Principal returned', amount: 500, date: new Date() } });
    const report = await api(f.token, '/analytics?period=month');
    assert.equal(report.status, 200);
    assert.equal(report.body.summary?.totalIncome, 200);
    assert.equal(report.body.summary?.loanCollections, 500);
    assert.equal(report.body.summary?.netCashFlow, 200);
  });
  await t.test('account deletion waits for PayMongo cancellation, including pending checkout', async () => {
    const f = await fixture();
    const now = new Date();
    await prisma.subscription.create({ data: { userId: f.user.id, provider: 'PAYMONGO', providerSubscriptionId: 'sub-delete-test', plan: 'FREE', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) } });
    assert.equal((await api(f.token, '/subscriptions/me')).body.paymentPending, true);
    const originalFetch = globalThis.fetch;
    const originalSecret = process.env.PAYMONGO_SECRET_KEY;
    const originalWebhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    let providerFails = true;
    let cancellationCalls = 0;
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_integration';
    process.env.PAYMONGO_WEBHOOK_SECRET = 'integration-webhook-secret';
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://api.paymongo.com/v1/subscriptions/')) {
        cancellationCalls++;
        assert.equal(init?.method, 'DELETE');
        return providerFails
          ? Response.json({ errors: [{ detail: 'Provider unavailable' }] }, { status: 503 })
          : Response.json({ data: { id: 'sub-delete-test', type: 'subscription', attributes: { status: 'cancelled' } } });
      }
      return originalFetch(input, init);
    };
    try {
      const input = { password, confirmation: 'DELETE' };
      assert.equal((await api(f.token, '/users/me', 'DELETE', input)).status, 502);
      assert.ok(await prisma.user.findUnique({ where: { id: f.user.id } }));
      providerFails = false;
      assert.equal((await api(f.token, '/subscriptions/cancel', 'POST', {})).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.paymentPending, false);
      const event = { data: { id: `evt-${randomUUID()}`, attributes: { type: 'subscription.activated', livemode: false, data: { id: 'sub-delete-test', type: 'subscription', attributes: { status: 'active' } } } } };
      const raw = JSON.stringify(event);
      const signature = createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(raw).digest('hex');
      const webhook = await originalFetch(`${base}/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'paymongo-signature': signature }, body: raw });
      assert.equal(webhook.status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'FREE');
      assert.equal((await api(f.token, '/users/me', 'DELETE', input)).status, 200);
      assert.equal(await prisma.user.findUnique({ where: { id: f.user.id } }), null);
      assert.equal(cancellationCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.PAYMONGO_SECRET_KEY;
      else process.env.PAYMONGO_SECRET_KEY = originalSecret;
      if (originalWebhookSecret === undefined) delete process.env.PAYMONGO_WEBHOOK_SECRET;
      else process.env.PAYMONGO_WEBHOOK_SECRET = originalWebhookSecret;
    }
  });
  await t.test('signed billing events require a paid invoice and ignore stale or replaced subscriptions', async () => {
    const f = await fixture();
    const now = new Date();
    await prisma.subscription.create({ data: { userId: f.user.id, provider: 'PAYMONGO', providerSubscriptionId: 'sub-order-test', plan: 'FREE', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) } });
    const previousSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    process.env.PAYMONGO_WEBHOOK_SECRET = 'integration-webhook-secret';
    const timestamp = Math.floor(Date.now() / 1000);
    async function event(type: string, status: string, offset: number, subscriptionId = 'sub-order-test') {
      const invoice = type.startsWith('subscription.invoice.');
      const payload = { data: { id: `evt-${randomUUID()}`, attributes: { type, livemode: false, created_at: timestamp + offset, data: { id: invoice ? `inv-${randomUUID()}` : subscriptionId, type: invoice ? 'invoice' : 'subscription', attributes: { status, ...(invoice ? { resource_id: subscriptionId } : {}) } } } } };
      const raw = JSON.stringify(payload);
      const signature = createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(raw).digest('hex');
      return fetch(`${base}/subscriptions/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'paymongo-signature': signature }, body: raw });
    }
    try {
      assert.equal((await event('subscription.activated', 'active', 1)).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'FREE');
      assert.equal((await event('subscription.invoice.paid', 'open', 2)).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'FREE');
      assert.equal((await event('subscription.invoice.paid', 'paid', 4)).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'PLUS');
      assert.equal((await event('subscription.invoice.payment_failed', 'failed', 3)).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'PLUS');
      assert.equal((await event('subscription.invoice.payment_failed', 'failed', 5)).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'FREE');
      await prisma.subscription.update({ where: { userId: f.user.id }, data: { providerSubscriptionId: 'sub-replacement-test', plan: 'FREE', status: 'ACTIVE' } });
      assert.equal((await event('subscription.invoice.paid', 'paid', 6)).status, 200);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'FREE');
    } finally {
      if (previousSecret === undefined) delete process.env.PAYMONGO_WEBHOOK_SECRET;
      else process.env.PAYMONGO_WEBHOOK_SECRET = previousSecret;
    }
  });
  await t.test('suspension cancels provider billing and admins can cancel for suspended users', async () => {
    const member = await fixture();
    const second = await fixture();
    const adminUser = await prisma.user.create({ data: { email: randomUUID() + '@example.test', password: hashed, firstName: 'Billing', lastName: 'Admin', accountRole: 'ADMIN', roles: [], emailVerified: new Date(), localCredentialVerified: true } });
    const adminToken = (await auth.loginUser({ email: adminUser.email, password })).accessToken;
    const now = new Date();
    for (const [fixtureUser, providerId] of [[member, 'sub-suspend-test'], [second, 'sub-operator-test']] as const) {
      await prisma.subscription.create({ data: { userId: fixtureUser.user.id, provider: 'PAYMONGO', providerSubscriptionId: providerId, plan: 'PLUS', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) } });
    }
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.PAYMONGO_SECRET_KEY;
    const cancelled: string[] = [];
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_integration';
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('https://api.paymongo.com/v1/subscriptions/') && init?.method === 'DELETE') {
        cancelled.push(String(input));
        return Response.json({ data: { id: String(input).split('/').at(-1), type: 'subscription', attributes: { status: 'cancelled' } } });
      }
      return originalFetch(input, init);
    };
    try {
      assert.equal((await api(member.token, `/users/admin/users/${second.user.id}/cancel-subscription`, 'POST', {})).status, 403);
      assert.equal((await api(adminToken, `/users/admin/users/${member.user.id}/status`, 'PATCH', { status: 'SUSPENDED' })).status, 200);
      assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { userId: member.user.id } })).status, 'CANCELLED');
      assert.equal((await api(member.token, '/subscriptions/me')).status, 401);
      await prisma.user.update({ where: { id: second.user.id }, data: { accountStatus: 'SUSPENDED' } });
      assert.equal((await api(adminToken, `/users/admin/users/${second.user.id}/cancel-subscription`, 'POST', {})).status, 200);
      assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { userId: second.user.id } })).status, 'CANCELLED');
      assert.equal(cancelled.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.PAYMONGO_SECRET_KEY;
      else process.env.PAYMONGO_SECRET_KEY = originalKey;
    }
  });
  await t.test('failed AI processing restores the monthly request allowance', async () => {
    const f = await fixture();
    const before = await api(f.token, '/subscriptions/me');
    const failed = await api(f.token, '/ai/chat', 'POST', { message: 'undo last transaction' });
    assert.ok(failed.status >= 400);
    const after = await api(f.token, '/subscriptions/me');
    assert.equal(after.body.limits?.aiRequests, before.body.limits?.aiRequests);
    const usage = await prisma.usagePeriod.findFirst({ where: { userId: f.user.id } });
    assert.equal(usage?.aiRequests, 0);
  });
  await t.test('bill reversal preserves later payments and blocks parent deletion', async () => {
    const f = await fixture();
    const bill = await prisma.fixedExpense.create({ data: { userId: f.user.id, name: 'Monthly bill', amount: 100, frequency: 'MONTHLY', dueDate: new Date(2026, 0, 31, 12) } });
    const pay = (amount: number) => withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'BILL_PAYMENT', fixedExpenseId: bill.id, walletId: f.wallet.id, description: 'Bill', category: 'Bills', amount, date: new Date() }));
    const first = await pay(40);
    await pay(60);
    await pay(100);
    await withFinancialOperation(f.user.id, tx => reverseMovement(tx, f.user.id, first.id));
    const result = await prisma.fixedExpense.findUniqueOrThrow({ where: { id: bill.id } });
    assert.equal(Number(result.amountPaid), 60);
    assert.equal(result.dueDate!.getMonth(), 1);
    assert.equal(result.dueDate!.getDate(), 28);
    assert.equal((await api(f.token, `/income-setup/fixed-expenses/${bill.id}`, 'DELETE')).status, 409);
  });
  await t.test('Safe-to-Spend retains completed savings and includes arrears and every occurrence', async () => {
    const f = await fixture();
    await prisma.incomeSetup.create({ data: { userId: f.user.id, totalIncome: 1000, incomePeriod: 'monthly' } });
    await withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'INCOME', walletId: f.wallet.id, amount: 1000, date: new Date(2026, 8, 5), description: 'Received income', category: 'Salary' }));
    const goal = await prisma.savingsGoal.create({ data: { userId: f.user.id, name: 'Goal', targetAmount: 100, monthlyAllocation: 100 } });
    await withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'SAVINGS_CONTRIBUTION', savingsGoalId: goal.id, walletId: f.wallet.id, amount: 100, date: new Date(2026, 8, 10), description: 'Save', category: 'Savings' }));
    assert.equal((await calculateSafeToSpend(f.user.id, new Date(2026, 8, 25))).safeToSpend, 900);
    await prisma.fixedExpense.create({ data: { userId: f.user.id, name: 'Weekly', amount: 100, amountPaid: 30, frequency: 'WEEKLY', status: 'PENDING', dueDate: new Date(2026, 8, 1), scheduleAnchor: new Date(2026, 8, 1) } });
    await prisma.fixedExpense.create({ data: { userId: f.user.id, name: 'Arrears', amount: 50, frequency: 'ONE_TIME', status: 'PENDING', dueDate: new Date(2026, 7, 15) } });
    const result = await calculateSafeToSpend(f.user.id, new Date(2026, 8, 25));
    assert.equal(result.totalFixed, 520);
    assert.equal(result.safeToSpend, 380);
  });
  await t.test('undated recurring bills get a schedule and paid reservations do not double count', async () => {
    const f = await fixture();
    await prisma.incomeSetup.create({ data: { userId: f.user.id, totalIncome: 1000, incomePeriod: 'monthly' } });
    const created = await api(f.token, '/income-setup/fixed-expenses', 'POST', { name: 'Undated', amount: 100, frequency: 'MONTHLY' });
    assert.equal(created.status, 201); assert.ok(created.body.expense.dueDate);
    const before = await calculateSafeToSpend(f.user.id);
    const pay = await api(f.token, '/transactions', 'POST', { type: 'BILL_PAYMENT', fixedExpenseId: created.body.expense.id, walletId: f.wallet.id, amount: 100, category: 'Bills', description: 'Pay bill', date: new Date().toISOString() });
    assert.equal(pay.status, 201);
    assert.equal((await calculateSafeToSpend(f.user.id)).safeToSpend, before.safeToSpend);
  });
  await t.test('AI confirmation is atomic and replayable and rolls back invalid actions', async () => {
    const f = await fixture();
    const pending = await prisma.aiSession.create({ data: { userId: f.user.id, question: 'Add income', answer: 'Confirm', model: 'test', promptTokens: 0, responseTokens: 0, totalTokens: 0, state: 'AWAITING_CONFIRMATION', pendingAction: { intent: 'LOG_TRANSACTION', transactionType: 'INCOME', description: 'Pay', category: 'Salary', amount: 100, walletName: 'Cash', date: '2026-09-25' } } });
    const results = await Promise.all([confirmAiAction(f.user.id, pending.id), confirmAiAction(f.user.id, pending.id)]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(await prisma.transaction.count({ where: { userId: f.user.id } }), 1);
    const bad = await prisma.aiSession.create({ data: { userId: f.user.id, question: 'Bad', answer: 'Confirm', model: 'test', promptTokens: 0, responseTokens: 0, totalTokens: 0, state: 'AWAITING_CONFIRMATION', pendingAction: { intent: 'LOG_TRANSACTION', transactionType: 'INCOME', description: 'Bad', category: 'Salary', amount: 100, walletName: 'Cash', date: 'not-a-date' } } });
    await assert.rejects(() => confirmAiAction(f.user.id, bad.id));
    assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: bad.id } })).state, 'AWAITING_CONFIRMATION');
    assert.equal(await prisma.financialOperation.count({ where: { userId: f.user.id, key: 'ai:' + bad.id } }), 0);
  });
  await t.test('repeated and overlapping imports are idempotent; explicit legitimate repeats remain possible', async () => {
    const f = await fixture();
    const csv = Buffer.from('Date,Description,Amount\n2026-09-25,Coffee,-50\n2026-09-25,Coffee,-50\n');
    await Promise.all([importStatement(f.user.id, f.wallet.id, csv), importStatement(f.user.id, f.wallet.id, csv)]);
    assert.equal(await prisma.transaction.count({ where: { userId: f.user.id } }), 2);
    const overlap = await importStatement(f.user.id, f.wallet.id, Buffer.from('Date,Description,Amount\n2026-09-25,Coffee,-50\n2026-09-26,Salary,100\n'));
    assert.equal(overlap.imported, 1); assert.equal(overlap.skipped, 1);
    const key = randomUUID();
    await importStatement(f.user.id, f.wallet.id, csv, true, key);
    await importStatement(f.user.id, f.wallet.id, csv, true, key);
    assert.equal(await prisma.transaction.count({ where: { userId: f.user.id } }), 5);
  });
  await t.test('legacy deleted parents do not prevent ledger reversal', async () => {
    const f = await fixture();
    const goal = await prisma.savingsGoal.create({ data: { userId: f.user.id, name: 'Legacy', targetAmount: 100 } });
    const movement = await withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { type: 'SAVINGS_CONTRIBUTION', savingsGoalId: goal.id, walletId: f.wallet.id, amount: 100, date: new Date(), category: 'Savings', description: 'Legacy' }));
    await prisma.savingsGoal.delete({ where: { id: goal.id } }); // Simulates pre-fix data only.
    assert.equal((await api(f.token, `/transactions/${movement.id}`, 'DELETE')).status, 200);
  });
  await t.test('refresh rotation has one winner and reset revokes previous access and reset links', async () => {
    const f = await fixture();
    const login = await auth.loginUser({ email: f.user.email, password });
    const refreshed = await auth.refreshUserSession(login.refreshToken);
    assert.notEqual(refreshed.refreshToken, login.refreshToken);
    const concurrent = await Promise.allSettled([auth.refreshUserSession(refreshed.refreshToken), auth.refreshUserSession(refreshed.refreshToken)]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
    const raw = randomBytes(32).toString('hex'), other = randomBytes(32).toString('hex');
    for (const value of [raw, other]) await prisma.token.create({ data: { userId: f.user.id, type: 'PASSWORD_RESET', token: auth.tokenFingerprint(value), expiresAt: new Date(Date.now() + 60000) } });
    await auth.resetUserPassword(raw, 'Replacement123!');
    await assert.rejects(() => auth.resetUserPassword(other, 'Attacker123!'));
    assert.equal((await api(f.token, '/users/me')).status, 401);
    assert.ok((await auth.loginUser({ email: f.user.email, password: 'Replacement123!' })).accessToken);
  });
  await t.test('Google linking removes pre-registered credentials and outstanding verification links', async () => {
    const email = randomUUID() + '@example.test';
    const victim = await prisma.user.create({ data: { email, firstName: 'Fake', lastName: 'Registrant', password: hashed, roles: [], emailVerified: new Date(), localCredentialVerified: false } });
    const raw = randomBytes(32).toString('hex');
    await prisma.token.create({ data: { userId: victim.id, type: 'VERIFICATION', token: auth.tokenFingerprint(raw), expiresAt: new Date(Date.now() + 60000) } });
    const google = await auth.loginWithGoogle({ subject: 'google-' + randomUUID(), email, emailVerified: true, name: 'Real Owner' });
    assert.equal(google.user.id, victim.id);
    await assert.rejects(() => auth.loginUser({ email, password }));
    await assert.rejects(() => auth.verifyUserEmail(raw));
    await assert.rejects(() => auth.loginWithGoogle({ subject: 'different-subject', email, emailVerified: true }));
  });
  await t.test('health score includes completed savings and excludes loans lent to others', async () => {
    const f = await fixture();
    await prisma.incomeSetup.create({ data: { userId: f.user.id, totalIncome: 1000, incomePeriod: 'monthly' } });
    await prisma.savingsGoal.create({ data: { userId: f.user.id, name: 'Complete', targetAmount: 100, currentAmount: 100, isCompleted: true } });
    await prisma.loan.create({ data: { userId: f.user.id, title: 'Lent', amount: 1000, type: 'LENT', status: 'ACTIVE', startDate: new Date(), deadline: new Date() } });
    const result = await api(f.token, '/user/health-score');
    assert.equal(result.status, 200);
    assert.equal(result.body.breakdown.savings, 30);
    assert.equal(result.body.breakdown.debt, 15);
  });
  await t.test('health score does not reward missing savings goals or a missing budget', async () => {
    const f = await fixture();
    await prisma.incomeSetup.create({ data: { userId: f.user.id, totalIncome: 1_000, incomePeriod: 'monthly' } });
    const result = await api(f.token, '/user/health-score');
    assert.equal(result.status, 200);
    assert.equal(result.body.breakdown.savings, 0);
    assert.equal(result.body.breakdown.spending, 0);
  });
  await t.test('main user journey configures a plan and records spending through the HTTP API', async () => {
    const f = await fixture();
    assert.equal((await api(f.token, '/income-setup', 'POST', { totalIncome: 30_000, incomePeriod: 'monthly' })).status, 200);
    assert.equal((await api(f.token, '/income-setup/fixed-expenses', 'POST', {
      name: 'Rent', amount: 8_000, frequency: 'MONTHLY', category: 'Housing', reminderDays: 3,
    })).status, 201);
    assert.equal((await api(f.token, '/budget', 'PUT', { targetAmount: 12_000 })).status, 200);
    const goal = await api(f.token, '/income-setup/savings-goals', 'POST', {
      name: 'Emergency fund', targetAmount: 60_000, monthlyAllocation: 2_000,
    });
    assert.equal(goal.status, 201);
    assert.equal((await api(f.token, '/transactions', 'POST', {
      walletId: f.wallet.id,
      description: 'Groceries',
      category: 'Food',
      type: 'EXPENSE',
      amount: 1_500,
      date: new Date().toISOString(),
    }, randomUUID())).status, 201);
    assert.equal((await api(f.token, '/users/me/onboarding', 'PATCH', { step: 5, complete: true })).status, 200);

    const setup = await api(f.token, '/income-setup');
    const budget = await api(f.token, '/budget');
    assert.equal(setup.body.setup?.totalIncome, 30_000);
    assert.equal(setup.body.safeToSpend, 0);
    assert.equal(budget.body.configured, true);
    assert.equal(budget.body.targetAmount, 12_000);
    assert.equal((await prisma.transaction.count({ where: { userId: f.user.id, deletedAt: null } })), 1);
    assert.equal((await prisma.savingsGoal.count({ where: { userId: f.user.id } })), 1);
  });
  await t.test('multi-month report aggregates the matching monthly budgets', async () => {
    const f = await fixture();
    for (const month of [1, 2]) await prisma.budget.create({ data: { userId: f.user.id, month, year: 2026, targetAmount: 1000, amountSpent: 0 } });
    const result = await api(f.token, '/analytics?period=custom&startDate=2026-01-01&endDate=2026-02-28');
    assert.equal(result.status, 200); assert.equal(result.body.budget.target, 2000);
  });
});
