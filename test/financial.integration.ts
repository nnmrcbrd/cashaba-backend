import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';

// Require an explicit test database. Every object and test user additionally
// lives in a random isolated schema. No application schema is queried.
const connectionString = process.env.TEST_DATABASE_URL;
test('PostgreSQL API and financial integration regressions', { skip: !connectionString, timeout: 360_000 }, async t => {
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
  await admin.query('DROP TABLE "RateLimitBucket"');
  await admin.query(await readFile(new URL('../prisma/migrations/20261002000000_shared_rate_limits/migration.sql', import.meta.url), 'utf8'));

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
      requiresClarification?: boolean; requiresConfirmation?: boolean; content?: string; walletOptions?: string[];
    };
    return { status: response.status, body: result };
  }

  await t.test('shared rate-limit migration counts concurrent requests atomically and expires counters', async () => {
    const { databaseRateLimit } = await import('../src/middlewares/rateLimit.middleware');
    const key = randomUUID();
    const counts = await Promise.all(Array.from({ length: 12 }, () => databaseRateLimit(key, 60_000)));
    assert.deepEqual(counts.map(item => item.count).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
    for (const entry of counts) assert.ok(entry.resetAt > Date.now() && entry.resetAt <= Date.now() + 60_000, 'Retry deadlines must not gain a timezone offset');
    assert.equal((await prisma.rateLimitBucket.findUniqueOrThrow({ where: { key } })).hits, 12);
    await prisma.rateLimitBucket.update({ where: { key }, data: { expiresAt: new Date(0) } });
    assert.equal((await databaseRateLimit(key, 60_000)).count, 1);
    assert.equal((await databaseRateLimit(randomUUID(), 60_000)).count, 1);
    const oldStore = process.env.RATE_LIMIT_STORE;
    process.env.RATE_LIMIT_STORE = 'postgres';
    try {
      const response = await fetch(base + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('RateLimit-Limit'), '60');
    } finally { if (oldStore === undefined) delete process.env.RATE_LIMIT_STORE; else process.env.RATE_LIMIT_STORE = oldStore; }
  });
  await t.test('cross-origin session requests cannot consume an existing refresh cookie', async () => {
    const f = await fixture();
    const signed = await auth.loginUser({ email: f.user.email, password });
    const cookie = 'refreshToken=' + signed.refreshToken;
    const response = await fetch(base + '/auth/refresh', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.example.test' } })).status, 403);
    const permitted = await fetch(base + '/auth/refresh', { method: 'POST', headers: { Cookie: cookie, Origin: new URL(process.env.FRONTEND_URL || 'http://localhost:3000').origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(permitted.status, 200);
  });
  await t.test('HTTP validation rejects bad budgets and dates with useful auth error details', async () => {
    const f = await fixture();
    for (const income of ['Infinity', 'not-a-number', -100, true]) assert.equal((await api(f.token, '/ai/suggest-budget', 'POST', { income, period: 'monthly' })).status, 400);
    assert.equal((await api(f.token, '/ai/suggest-budget', 'POST', { income: 7, period: 'monthly' })).status, 200);
    assert.equal((await api(f.token, '/transactions', 'POST', { walletId: f.wallet.id, type: 'EXPENSE', amount: 100, category: 'Others', description: 'Test', date: '2026-02-30' })).status, 400);
    const invalidLogin = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bad', password: '' }) });
    assert.equal(invalidLogin.status, 400);
    assert.ok(Array.isArray((await invalidLogin.json() as { errors?: unknown }).errors));
  });
  await t.test('malformed model budgets and insights cannot publish invented money', async () => {
    const f = await fixture();
    const now = new Date();
    await prisma.subscription.create({ data: { userId: f.user.id, plan: 'PLUS', status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 86_400_000) } });
    await prisma.incomeSetup.create({ data: { userId: f.user.id, totalIncome: 1000, incomePeriod: 'monthly' } });
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const oldModel = GoogleGenerativeAI.prototype.getGenerativeModel, oldKey = process.env.GEMINI_API_KEY;
    let output = '{"weeklyAllowance":999999999,"summary":"Guaranteed profits"}';
    process.env.GEMINI_API_KEY = 'synthetic-audit-key';
    GoogleGenerativeAI.prototype.getGenerativeModel = (() => ({ generateContent: async () => ({ response: { text: () => output } }) })) as unknown as typeof oldModel;
    try {
      const response = await fetch(base + '/ai/suggest-budget', { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ income: 1000, period: 'monthly' }) });
      assert.equal(response.status, 200);
      const plan = await response.json() as { weeklyAllowance: number; summary: string };
      assert.ok(plan.weeklyAllowance < 1000);
      assert.ok(!plan.summary.includes('Guaranteed'));
      output = '["You have ₱999999999 available",{"wrong":"shape"}]';
      const insights = await fetch(base + '/ai/insights', { headers: { Authorization: 'Bearer ' + f.token } });
      assert.equal(insights.status, 200);
      const cards = await insights.json() as { insights: Array<{ message: string }> };
      assert.equal(cards.insights.length, 3);
      assert.ok(cards.insights.every(item => !item.message.includes('999999999')));
      const usage = await prisma.usagePeriod.findFirstOrThrow({ where: { userId: f.user.id } });
      assert.equal(usage.aiRequests, 0);
    } finally {
      GoogleGenerativeAI.prototype.getGenerativeModel = oldModel;
      if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    }
  });

  await t.test('AI provider payload aliases account names and excludes stored descriptions without breaking previews', async () => {
    const f = await fixture();
    await prisma.wallet.update({ where: { id: f.wallet.id }, data: { name: 'Personal Cash' } });
    await withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { walletId: f.wallet.id, amount: 100, type: 'INCOME', category: 'Salary', description: 'private medical detail', date: new Date() }));
    await prisma.aiSession.create({ data: { userId: f.user.id, question: 'Can I use Personal Cash for meals?', answer: 'Review your food budget before deciding.', model: 'test', promptTokens: 0, responseTokens: 0, totalTokens: 0, state: 'COMPLETED' } });
    const originalFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY;
    let captured = '';
    process.env.GEMINI_API_KEY = 'synthetic-audit-key';
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(base)) return originalFetch(input, init);
      assert.ok(url.includes('generativelanguage.googleapis.com'), 'Unexpected external request blocked');
      const body = JSON.parse(String(init?.body)) as { systemInstruction?: { parts?: Array<{ text?: string }> }; system_instruction?: { parts?: Array<{ text?: string }> } };
      captured = JSON.stringify(body);
      const prompt = (body.systemInstruction?.parts ?? body.system_instruction?.parts ?? []).map(part => part.text).join('\n');
      const walletAlias = prompt.match(/"wallets":\[\{"name":"(CASHA_ENTITY_\d+)"/)?.[1];
      assert.ok(walletAlias);
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ intent: 'LOG_TRANSACTION', amount: 50, description: 'Lunch', category: 'Food & Dining', transactionType: 'EXPENSE', walletName: walletAlias, date: 'today' }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } });
    };
    try {
      const response = await api(f.token, '/ai/chat', 'POST', { message: 'I spent 50 on lunch using Personal Cash today' });
      assert.equal(response.status, 200);
      assert.equal(response.body.requiresConfirmation, true);
      assert.ok(response.body.content?.includes('Personal Cash'));
      assert.ok(captured && !captured.includes('Personal Cash'));
      assert.ok(!captured.includes('private medical detail'));
      assert.ok(captured.includes('recentConversation'));
      assert.ok(captured.includes('Review your food budget before deciding.'));
    } finally {
      globalThis.fetch = originalFetch;
      if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
    }
  });

  await t.test('personal advice reads only the signed-in user, answers goal timelines and never writes money', async () => {
    const a = await fixture(), b = await fixture();
    await prisma.incomeSetup.create({ data: { userId: a.user.id, totalIncome: 2000, incomePeriod: 'weekly' } });
    await prisma.savingsGoal.create({ data: { userId: a.user.id, name: 'Phone', targetAmount: 12000, currentAmount: 1000, monthlyAllocation: 2000 } });
    await prisma.savingsGoal.create({ data: { userId: b.user.id, name: 'Phone', targetAmount: 90000, currentAmount: 10000, monthlyAllocation: 8000 } });
    const timeline = await api(a.token, '/ai/chat', 'POST', { message: 'how many months will it take for me to buy the latest phone?' });
    assert.equal(timeline.status, 200);
    assert.match(timeline.body.content!, /6 months/);
    assert.match(timeline.body.content!, /12,000\.00/);
    assert.doesNotMatch(timeline.body.content!, /90,000\.00|10,000\.00/);
    assert.notEqual(timeline.body.requiresConfirmation, true);
    const unknown = await api(b.token, '/ai/chat', 'POST', { message: 'How long will it take to buy a laptop?' });
    assert.match(unknown.body.content!, /need the phone\/item price/);
    const income = await api(a.token, '/ai/chat', 'POST', { message: 'How much is my income?' });
    assert.equal(income.status, 200);
    assert.match(income.body.content!, /planned income is ₱2,000\.00 per week/);
    assert.match(income.body.content!, /recorded ₱0\.00/);
    const before = await api(a.token, '/ai/chat', 'POST', { message: 'Why is my Safe-to-Spend zero?' });
    assert.match(before.body.content!, /received income ₱0\.00/);
    await withFinancialOperation(a.user.id, tx => recordMovement(tx, a.user.id, { walletId: a.wallet.id, amount: 500, type: 'INCOME', category: 'Allowance', description: 'Received allowance', date: new Date() }));
    const after = await api(a.token, '/ai/chat', 'POST', { message: 'How much is my income?' });
    assert.match(after.body.content!, /recorded ₱500\.00/);
    assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 1);
    assert.equal(await prisma.transaction.count({ where: { userId: b.user.id } }), 0);
  });

  await t.test('savings conversation persists price and allocation, isolates users and retains financial confirmation', async () => {
    // Exercise the authenticated chat controller separately from the shared IP
    // limiter, so a multi-turn regression does not exhaust unrelated API tests.
    const express = (await import('express')).default;
    const { authenticate } = await import('../src/middlewares/auth.middleware');
    const { processAiChat, getAiHistory } = await import('../src/controllers/aiCommand.controller');
    const conversationApp = express();
    conversationApp.use(express.json());
    conversationApp.post('/chat', authenticate, processAiChat);
    conversationApp.get('/history', authenticate, getAiHistory);
    const conversationServer = conversationApp.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => conversationServer.once('listening', resolve));
    const chatAddress = conversationServer.address();
    assert.ok(chatAddress && typeof chatAddress !== 'string');
    const chatBase = `http://127.0.0.1:${chatAddress.port}`;
    type Reply = { id?: string; content?: string; requiresClarification?: boolean; requiresConfirmation?: boolean };
    async function chat(token: string, message: string, ids: { clarificationId?: string; confirmationId?: string } = {}) {
      const response = await fetch(chatBase + '/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, ...ids }) });
      return { status: response.status, body: await response.json() as Reply };
    }
    try {
      const a = await fixture(), b = await fixture();
      await prisma.subscription.create({ data: { userId: a.user.id, plan: 'PLUS', status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
      await prisma.incomeSetup.create({ data: { userId: a.user.id, totalIncome: 10000, incomePeriod: 'monthly' } });
      await prisma.savingsGoal.create({ data: { userId: b.user.id, name: 'Private iPhone', targetAmount: 90000, currentAmount: 60000, monthlyAllocation: 10000 } });
      await withFinancialOperation(a.user.id, async tx => {
        await recordMovement(tx, a.user.id, { walletId: a.wallet.id, amount: 2500, type: 'INCOME', category: 'Allowance', description: 'Fixture income', date: new Date() });
        await recordMovement(tx, a.user.id, { walletId: a.wallet.id, amount: 2648, type: 'EXPENSE', category: 'Bills', description: 'Fixture expense', date: new Date() });
      });
      const question = await chat(a.token, 'how long will it take for me to buy latest iphone?');
      assert.equal(question.status, 200);
      assert.equal(question.body.requiresClarification, true);
      assert.match(question.body.content!, /price in pesos/);
      assert.doesNotMatch(question.body.content!, /Private iPhone|90,000\.00/);
      assert.equal((await chat(b.token, '194,990', { clarificationId: question.body.id })).status, 409);
      const price = await chat(a.token, '194,990', { clarificationId: question.body.id });
      assert.equal(price.status, 200);
      assert.match(price.body.content!, /194,990\.00/);
      assert.match(price.body.content!, /How much can you set aside/);
      const restored = await fetch(chatBase + '/history', { headers: { Authorization: 'Bearer ' + a.token } });
      const history = await restored.json() as Array<{ id: string; state: string; pendingAction: { kind?: string; price?: number } }>;
      assert.equal(history.at(-1)?.pendingAction.price, 194990);
      assert.equal(history.filter(turn => turn.state === 'NEEDS_CLARIFICATION').length, 1);
      const explanation = await chat(a.token, 'what do u mean by transaction?', { clarificationId: history.at(-1)!.id });
      assert.match(explanation.body.content!, /^A transaction is a financial entry/);
      const plan = await chat(a.token, '2000 per month', { clarificationId: explanation.body.id });
      assert.equal(plan.status, 200);
      assert.match(plan.body.content!, /98 months/);
      assert.match(plan.body.content!, /Safe-to-Spend is ₱0\.00/);
      assert.notEqual(plan.body.requiresConfirmation, true);
      assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 2);
      assert.equal(await prisma.savingsGoal.count({ where: { userId: a.user.id } }), 0);
      const simple = await chat(a.token, 'what? i dont get it');
      assert.equal(simple.status, 200);
      assert.match(simple.body.content!, /^In simpler terms:/);
      assert.match(simple.body.content!, /98 months/);
      const thousand = await chat(a.token, '1000 per month');
      assert.match(thousand.body.content!, /195 months \(16 years and 3 months\)/);
      const simplified = await chat(a.token, 'can you explain that?');
      assert.match(simplified.body.content!, /195 months/);
      assert.doesNotMatch(simplified.body.content!, /I can help you plan/);
      const next = await chat(a.token, 'what should i do next?');
      assert.match(next.body.content!, /Budget & Goals/);
      await withFinancialOperation(a.user.id, tx => recordMovement(tx, a.user.id, { walletId: a.wallet.id, amount: 500, type: 'INCOME', category: 'Allowance', description: 'Additional fixture income', date: new Date() }));
      const updated = await chat(a.token, 'what if I can save 5000 per month?');
      assert.equal(updated.status, 200);
      assert.match(updated.body.content!, /39 months/);
      const freshIncome = await chat(a.token, 'How much income have I received?');
      assert.match(freshIncome.body.content!, /recorded ₱3,000\.00/);
      // Resume a fresh saved planning context after deliberately changing topics.
      const resumed = await chat(a.token, 'How long to buy a phone worth PHP 194990 at 5000 per month?');
      assert.match(resumed.body.content!, /39 months/);
      const why = await chat(a.token, 'why is it so long?');
      assert.match(why.body.content!, /39 months/);
      assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 3);
      await prisma.savingsGoal.create({ data: { userId: a.user.id, name: 'Phone', targetAmount: 5000, currentAmount: 0, monthlyAllocation: 1000 } });
      const action = await chat(a.token, 'Save 500 to Phone from Cash today');
      assert.equal(action.status, 200);
      assert.equal(action.body.requiresConfirmation, true);
      const clarifyAction = await chat(a.token, 'What is a transaction?');
      assert.match(clarifyAction.body.content!, /^A transaction is/);
      assert.equal(clarifyAction.body.id, action.body.id);
      assert.equal(clarifyAction.body.requiresConfirmation, true);
      assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: action.body.id } })).state, 'AWAITING_CONFIRMATION');
      assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 3);
      assert.equal((await chat(a.token, 'confirm', { confirmationId: action.body.id })).status, 200);
      assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 4);
      assert.equal(Number((await prisma.savingsGoal.findFirstOrThrow({ where: { userId: a.user.id } })).currentAmount), 500);
      const budget = await chat(a.token, 'How do I set a monthly budget?');
      assert.match(budget.body.content!, /Planning → Budget & Goals/);
      const budgetSimple = await chat(a.token, 'I don’t understand');
      assert.match(budgetSimple.body.content!, /limit you choose for monthly spending/);
      const reset = await chat(a.token, 'start over');
      assert.equal(reset.status, 200);
      const unrelatedAmount = await chat(a.token, '194990');
      assert.match(unrelatedAmount.body.content!, /What does/);
      assert.doesNotMatch(unrelatedAmount.body.content!, /195 months|39 months/);

      // Read-only questions must not replace or execute a pending money entry.
      const draft = await chat(a.token, 'I spent 100 on lunch today');
      assert.equal(draft.body.requiresClarification, true);
      const explainDraft = await chat(a.token, 'what? i dont get it', { clarificationId: draft.body.id });
      assert.match(explainDraft.body.content!, /account the money came from/);
      assert.equal(explainDraft.body.id, draft.body.id);
      assert.equal(explainDraft.body.requiresClarification, true);
      const howTo = await chat(a.token, 'How do transfers work?', { clarificationId: draft.body.id });
      assert.match(howTo.body.content!, /not income or spending/);
      assert.equal(howTo.body.id, draft.body.id);
      assert.equal(howTo.body.requiresClarification, true);
      assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: draft.body.id } })).state, 'NEEDS_CLARIFICATION');
      const account = await chat(a.token, 'Cash', { clarificationId: draft.body.id });
      assert.equal(account.body.requiresConfirmation, true);
      const featureQuestion = await chat(a.token, 'How does my budget work?');
      assert.match(featureQuestion.body.content!, /monthly spending limit/);
      assert.equal(featureQuestion.body.id, account.body.id);
      assert.equal(featureQuestion.body.requiresConfirmation, true);
      assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 4);
      assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: account.body.id } })).state, 'AWAITING_CONFIRMATION');
      assert.equal((await chat(a.token, 'cancel', { confirmationId: account.body.id })).status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => conversationServer.close(error => error ? reject(error) : resolve()));
    }
  });

  await t.test('conversational Gemini replies use fresh server facts, aliases and history; fabricated numbers fall back', async () => {
    const f = await fixture();
    await prisma.wallet.update({ where: { id: f.wallet.id }, data: { name: 'Private Cash' } });
    await withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { walletId: f.wallet.id, type: 'INCOME', amount: 2500, category: 'Salary', description: 'Private ledger description', date: new Date() }));
    const express = (await import('express')).default;
    const { authenticate } = await import('../src/middlewares/auth.middleware');
    const { processAiChat } = await import('../src/controllers/aiCommand.controller');
    const chatApp = express(); chatApp.use(express.json()); chatApp.post('/chat', authenticate, processAiChat);
    const chatServer = chatApp.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => chatServer.once('listening', resolve));
    const address = chatServer.address(); assert.ok(address && typeof address !== 'string');
    const chatBase = `http://127.0.0.1:${address.port}`;
    const originalFetch = globalThis.fetch, oldKey = process.env.GEMINI_API_KEY;
    let captured = '', hallucinate = false;
    process.env.GEMINI_API_KEY = 'synthetic-audit-key';
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(chatBase)) return originalFetch(input, init);
      assert.ok(url.includes('generativelanguage.googleapis.com'));
      captured = String(init?.body);
      const body = JSON.parse(captured) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const payload = JSON.parse(body.contents[0]!.parts[0]!.text) as { verifiedAnswer: string };
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ reply: hallucinate ? 'You have ₱999999 available.' : payload.verifiedAnswer }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } });
    };
    const chat = async (message: string) => {
      const response = await fetch(chatBase + '/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      assert.equal(response.status, 200);
      return await response.json() as { content: string; model: string; requiresConfirmation?: boolean };
    };
    try {
      const balance = await chat('What is my account balance?');
      assert.match(balance.model, /^gemini-/);
      assert.match(balance.content, /Private Cash: ₱12,500\.00/);
      assert.ok(!captured.includes('Private Cash') && !captured.includes('Private ledger description'));
      assert.ok(captured.includes('verifiedReferences') && captured.includes('[[fact_'));
      await chat('what? i dont get it');
      assert.ok(captured.includes('What is my account balance?'));
      assert.equal(((await prisma.aiSession.findFirstOrThrow({ where: { userId: f.user.id }, orderBy: { createdAt: 'desc' } })).pendingAction as { kind?: string }).kind, 'CORE_CONVERSATION');
      await withFinancialOperation(f.user.id, tx => recordMovement(tx, f.user.id, { walletId: f.wallet.id, type: 'INCOME', amount: 500, category: 'Salary', description: 'Additional synthetic income', date: new Date() }));
      const fresh = await chat('How much income have I received?');
      assert.match(fresh.content, /recorded ₱3,000\.00/);
      hallucinate = true;
      const rejected = await chat('How much income have I received?');
      assert.equal(rejected.model, 'local-core-conversation-v1');
      assert.match(rejected.content, /recorded ₱3,000\.00/);
      assert.doesNotMatch(rejected.content, /999999/);
      assert.notEqual(rejected.requiresConfirmation, true);
      assert.equal(await prisma.transaction.count({ where: { userId: f.user.id } }), 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey;
      await new Promise<void>((resolve, reject) => chatServer.close(error => error ? reject(error) : resolve()));
    }
  });

  await t.test('email registration requires a one-use OTP before sign-in and onboarding', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const originalTransport = nodemailer.createTransport;
    const oldHost = process.env.SMTP_HOST;
    const oldFrom = process.env.MAIL_FROM;
    let code = '';
    process.env.SMTP_HOST = 'synthetic-mail.example.test';
    process.env.MAIL_FROM = 'test@example.test';
    nodemailer.createTransport = (() => ({ sendMail: async (mail: { text: string }) => {
      code = mail.text.match(/code is: (\d{6})/)![1];
      return { accepted: ['synthetic recipient'] };
    } })) as typeof nodemailer.createTransport;
    try {
      const existing = await fixture();
      const prior = await auth.loginUser({ email: existing.user.email, password });
      const email = randomUUID() + '@example.test';
      const input = { firstName: 'New', lastName: 'User', gender: 'Female', email, password };
      const signup = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'refreshToken=' + prior.refreshToken }, body: JSON.stringify(input) });
      assert.equal(signup.status, 201);
      const result = await signup.json() as { requiresEmailVerification: boolean; challengeId: string; accessToken?: string; refreshToken?: string; code?: string };
      assert.equal(result.requiresEmailVerification, true);
      assert.equal(result.accessToken, undefined);
      assert.equal(result.refreshToken, undefined);
      assert.equal(result.code, undefined);
      assert.match(signup.headers.get('set-cookie')!, /refreshToken=;/);
      await assert.rejects(auth.refreshUserSession(prior.refreshToken), /no longer active/);
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      assert.equal(user.localCredentialVerified, false);
      assert.equal(user.emailVerified, null);
      assert.equal(user.onboardingCompletedAt, null);
      assert.equal(await prisma.aiSession.count({ where: { userId: user.id } }), 0);
      const login = () => fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const denied = await login();
      assert.equal(denied.status, 401);
      assert.match((await denied.json() as { message: string }).message, /verify your email/);
      assert.match(code, /^\d{6}$/);
      const verify = () => fetch(base + '/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId: result.challengeId, code }) });
      assert.equal((await verify()).status, 200);
      assert.equal((await verify()).status, 400);
      const allowed = await login();
      assert.equal(allowed.status, 200);
      const signedIn = await allowed.json() as { user: { onboardingComplete: boolean; onboardingStep: number }; accessToken: string };
      assert.equal(signedIn.user.onboardingComplete, false);
      assert.equal(signedIn.user.onboardingStep, 1);
      assert.ok(signedIn.accessToken);
    } finally {
      nodemailer.createTransport = originalTransport;
      if (oldHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = oldHost;
      if (oldFrom === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = oldFrom;
    }
  });

  await t.test('recovery requires an emailed OTP, exposes no development shortcut and revokes sessions after reset', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const original = nodemailer.createTransport, oldHost = process.env.SMTP_HOST, oldFrom = process.env.MAIL_FROM;
    let code = '', sent = 0;
    process.env.SMTP_HOST = 'synthetic-mail.example.test'; process.env.MAIL_FROM = 'test@example.test';
    nodemailer.createTransport = (() => ({ sendMail: async (mail: { text: string }) => { code = mail.text.match(/code is: (\d{6})/)![1]; sent++; return {}; } })) as typeof nodemailer.createTransport;
    try {
      const f = await fixture();
      const prior = await auth.loginUser({ email: f.user.email, password });
      const response = await api(f.token, '/auth/forgot-password', 'POST', { email: f.user.email });
      assert.equal(response.status, 200);
      const challenge = response.body as unknown as { challengeId: string; expiresInSeconds: number; code?: string; developmentResetUrl?: string; resetToken?: string };
      assert.match(challenge.challengeId, /^[a-f0-9-]{36}$/);
      assert.equal(challenge.expiresInSeconds, 600);
      assert.equal(challenge.code, undefined); assert.equal(challenge.developmentResetUrl, undefined); assert.equal(challenge.resetToken, undefined);
      const unknown = await api(f.token, '/auth/forgot-password', 'POST', { email: randomUUID() + '@example.test' });
      assert.equal(unknown.status, 200);
      assert.deepEqual(Object.keys(unknown.body).sort(), Object.keys(response.body).sort());
      assert.equal(sent, 1);
      const incorrect = code === '000000' ? '111111' : '000000';
      assert.equal((await api(f.token, '/auth/verify-reset-code', 'POST', { challengeId: challenge.challengeId, code: incorrect })).status, 400);
      const verified = await api(f.token, '/auth/verify-reset-code', 'POST', { challengeId: challenge.challengeId, code });
      assert.equal(verified.status, 200);
      const resetToken = (verified.body as unknown as { resetToken: string }).resetToken;
      assert.equal((await api(f.token, '/auth/verify-reset-code', 'POST', { challengeId: challenge.challengeId, code })).status, 400);
      assert.equal((await api(f.token, '/auth/reset-password', 'POST', { token: resetToken, newPassword: 'Replacement123!' })).status, 200);
      assert.equal((await api(f.token, '/auth/reset-password', 'POST', { token: resetToken, newPassword: 'Attacker123!' })).status, 400);
      assert.equal((await api(f.token, '/wallets')).status, 401);
      await assert.rejects(auth.refreshUserSession(prior.refreshToken));
      await assert.rejects(auth.loginUser({ email: f.user.email, password }));
      assert.ok((await auth.loginUser({ email: f.user.email, password: 'Replacement123!' })).accessToken);
    } finally {
      nodemailer.createTransport = original;
      if (oldHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = oldHost;
      if (oldFrom === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = oldFrom;
    }
  });

  await t.test('OTP attempts, expiry, resend invalidation, purpose and concurrency are enforced by shared storage', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const original = nodemailer.createTransport, oldHost = process.env.SMTP_HOST, oldFrom = process.env.MAIL_FROM;
    const { requestEmailOtp } = await import('../src/services/emailOtp');
    let code = '';
    process.env.SMTP_HOST = 'synthetic-mail.example.test'; process.env.MAIL_FROM = 'test@example.test';
    nodemailer.createTransport = (() => ({ sendMail: async (mail: { text: string }) => { code = mail.text.match(/code is: (\d{6})/)![1]; return {}; } })) as typeof nodemailer.createTransport;
    try {
      const locked = await fixture();
      const first = await requestEmailOtp(locked.user.email, 'PASSWORD_RESET');
      const originalCode = code;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let index = 0; index < 5; index++) await assert.rejects(auth.verifyPasswordResetCode(first.challengeId, wrong), /Invalid or expired/);
      assert.ok((await prisma.token.findUniqueOrThrow({ where: { id: first.challengeId } })).revokedAt);
      await assert.rejects(auth.verifyPasswordResetCode(first.challengeId, originalCode));
      assert.ok((await auth.loginUser({ email: locked.user.email, password })).accessToken, 'Failed reset guesses do not lock the account');

      const expired = await fixture();
      const stale = await requestEmailOtp(expired.user.email, 'PASSWORD_RESET');
      await assert.rejects(auth.verifyUserEmailCode(stale.challengeId, code));
      await prisma.token.update({ where: { id: stale.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await assert.rejects(auth.verifyPasswordResetCode(stale.challengeId, code));

      const resent = await fixture();
      const oldChallenge = await requestEmailOtp(resent.user.email, 'PASSWORD_RESET'), oldCode = code;
      await assert.rejects(requestEmailOtp(resent.user.email, 'PASSWORD_RESET'), /wait one minute/);
      const limited = await fetch(base + '/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: resent.user.email }) });
      assert.equal(limited.status, 429);
      const limitedBody = await limited.json() as { retryAfterSeconds: number };
      assert.ok(limitedBody.retryAfterSeconds > 0 && limitedBody.retryAfterSeconds <= 60, JSON.stringify(limitedBody));
      assert.equal(Number(limited.headers.get('Retry-After')), limitedBody.retryAfterSeconds);
      const key = createHash('sha256').update(`otp-send-minute:PASSWORD_RESET:${resent.user.email}`).digest('hex');
      await prisma.rateLimitBucket.update({ where: { key }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const latest = await requestEmailOtp(resent.user.email, 'PASSWORD_RESET'), latestCode = code;
      await assert.rejects(auth.verifyPasswordResetCode(oldChallenge.challengeId, oldCode));
      const attempts = await Promise.allSettled([auth.verifyPasswordResetCode(latest.challengeId, latestCode), auth.verifyPasswordResetCode(latest.challengeId, latestCode)]);
      assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(await prisma.token.count({ where: { userId: resent.user.id, type: 'PASSWORD_RESET', consumedAt: null, revokedAt: null, NOT: { token: { startsWith: 'otp:' } } } }), 1);

      const failed = await fixture();
      nodemailer.createTransport = (() => ({ sendMail: async () => { throw new Error('Synthetic delivery failure'); } })) as typeof nodemailer.createTransport;
      const undelivered = await requestEmailOtp(failed.user.email, 'PASSWORD_RESET');
      assert.ok((await prisma.token.findUniqueOrThrow({ where: { id: undelivered.challengeId } })).revokedAt);
    } finally {
      nodemailer.createTransport = original;
      if (oldHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = oldHost;
      if (oldFrom === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = oldFrom;
    }
  });

  await t.test('missing SMTP cannot issue recovery shortcuts or create an auto-verified account', async () => {
    const oldHost = process.env.SMTP_HOST, oldFrom = process.env.MAIL_FROM;
    delete process.env.SMTP_HOST; delete process.env.MAIL_FROM;
    try {
      const f = await fixture();
      const known = await api(f.token, '/auth/forgot-password', 'POST', { email: f.user.email });
      const unknown = await api(f.token, '/auth/forgot-password', 'POST', { email: randomUUID() + '@example.test' });
      assert.equal(known.status, 503); assert.equal(unknown.status, 503);
      assert.deepEqual(known.body, unknown.body);
      assert.deepEqual(Object.keys(known.body), ['message']);
      // Repeated server-configuration failures must never use up the hourly IP
      // recovery quota, or conceal the setup problem behind an unrelated 429.
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await fetch(base + '/auth/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.user.email }) });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('RateLimit-Limit'), null);
      }
      assert.equal((await api(f.token, '/auth/resend-verification', 'POST', { email: f.user.email })).status, 503);
      const email = randomUUID() + '@example.test';
      assert.equal((await api(f.token, '/auth/signup', 'POST', { firstName: 'New', lastName: 'User', gender: 'Female', email, password })).status, 503);
      assert.equal(await prisma.user.count({ where: { email } }), 0);
    } finally {
      if (oldHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = oldHost;
      if (oldFrom === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = oldFrom;
    }
  });

  await t.test('configured email requests still enforce the hourly IP limit and report its retry delay', async () => {
    const oldHost = process.env.SMTP_HOST, oldFrom = process.env.MAIL_FROM;
    process.env.SMTP_HOST = 'synthetic-mail.example.test'; process.env.MAIL_FROM = 'test@example.test';
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(base + '/auth/resend-verification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: randomUUID() + '@example.test' }) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('RateLimit-Limit'), '5');
      }
      const blocked = await fetch(base + '/auth/resend-verification', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: randomUUID() + '@example.test' }) });
      assert.equal(blocked.status, 429);
      const body = await blocked.json() as { retryAfterSeconds: number };
      assert.ok(body.retryAfterSeconds > 0 && body.retryAfterSeconds <= 3600);
      assert.equal(Number(blocked.headers.get('Retry-After')), body.retryAfterSeconds);
      assert.equal(blocked.headers.get('RateLimit-Remaining'), '0');
    } finally {
      if (oldHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = oldHost;
      if (oldFrom === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = oldFrom;
    }
  });

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
    assert.equal(cancelled.body.plan, 'FREE');
    assert.equal(cancelled.body.cancelAtPeriodEnd, false);
    assert.equal(cancelled.body.limits.aiRequests, 10);
    assert.equal(cancelled.body.limits.receiptScans, 5);
  });
  await t.test('a failed scan can restore its reserved monthly quota', async () => {
    const f = await fixture();
    const usage = await consumeUsage(f.user.id, 'receiptScans');
    assert.equal((await getSubscriptionSummary(f.user.id)).used.receiptScans, 1);
    await refundUsage(f.user.id, 'receiptScans', usage.id);
    assert.equal((await getSubscriptionSummary(f.user.id)).used.receiptScans, 0);
  });
  await t.test('hosted test checkout verifies provider payment, preserves ownership and fulfills only once', async () => {
    const f = await fixture(), other = await fixture();
    const originalFetch = globalThis.fetch;
    const previousMode = process.env.BILLING_MODE;
    const previousKey = process.env.PAYMONGO_SECRET_KEY;
    process.env.BILLING_MODE = 'paymongo_test';
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_example';
    const sessions = new Map<string, { id: string; type: string; attributes: Record<string, unknown> }>();
    let creations = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.paymongo.com/v2/checkout_sessions') {
        const attributes = JSON.parse(String(init?.body)).data.attributes;
        const id = `cs_test_${++creations}`;
        const session = { id, type: 'checkout_session', attributes: { ...attributes, status: 'active', livemode: false, checkout_url: `https://checkout.paymongo.com/${id}`, payments: [] } };
        sessions.set(id, session);
        return Response.json({ data: session });
      }
      if (url.startsWith('https://api.paymongo.com/v1/checkout_sessions/')) {
        return Response.json({ data: sessions.get(url.split('/').at(-1)!) });
      }
      return originalFetch(input, init);
    };
    try {
      const path = '/subscriptions/paymongo/test/checkout';
      assert.equal((await api(f.token, path, 'POST', {})).status, 201);
      assert.equal((await api(f.token, '/subscriptions/me')).body.plan, 'FREE');
      assert.equal((await api(f.token, path, 'POST', {})).status, 201);
      assert.equal(creations, 1, 'pending checkout is reused');
      assert.equal((await api(f.token, '/subscriptions/me?payment=success')).body.plan, 'FREE', 'a return URL cannot grant Plus');
      assert.equal((await api(other.token, '/subscriptions/paymongo/test/verify', 'POST', { checkoutId: 'cs_test_1' })).body.plan, 'FREE');
      const session = sessions.get('cs_test_1')!;
      session.attributes.payments = [{ id: 'pay_test', type: 'payment', attributes: { status: 'paid', amount: 9900, currency: 'PHP', livemode: false } }];
      session.attributes.reference_number = other.user.id;
      assert.equal((await api(f.token, '/subscriptions/paymongo/test/verify', 'POST', {})).status, 409);
      session.attributes.reference_number = f.user.id;
      session.attributes.livemode = true;
      assert.equal((await api(f.token, '/subscriptions/paymongo/test/verify', 'POST', {})).status, 502);
      session.attributes.livemode = false;
      const results = await Promise.all([api(f.token, '/subscriptions/paymongo/test/verify', 'POST', {}), api(f.token, '/subscriptions/paymongo/test/verify', 'POST', {})]);
      assert.ok(results.every(result => result.status === 200 && result.body.plan === 'PLUS'));
      assert.equal(await prisma.billingEvent.count({ where: { providerEventId: 'paymongo-test-checkout:cs_test_1' } }), 1);
      const paid = await prisma.subscription.findUniqueOrThrow({ where: { userId: f.user.id } });
      assert.equal(paid.currentPeriodEnd.getTime() - paid.currentPeriodStart.getTime(), 30 * 86_400_000);
      assert.equal((await api(f.token, path, 'POST', {})).status, 409);
      assert.equal((await api(f.token, '/subscriptions/cancel', 'POST', {})).body.plan, 'FREE');
      assert.equal((await api(f.token, '/subscriptions/paymongo/test/verify', 'POST', {})).body.plan, 'FREE', 'old payment cannot reactivate a downgrade');
      assert.equal((await api(f.token, path, 'POST', {})).status, 201);
      assert.equal(creations, 2);
      assert.equal((await api(f.token, '/subscriptions/cancel', 'POST', {})).body.plan, 'FREE', 'pending test checkout can be cancelled');
      process.env.PAYMONGO_SECRET_KEY = 'sk_live_example';
      assert.equal((await api(other.token, path, 'POST', {})).status, 503);
      assert.equal(creations, 2, 'live key never creates a checkout');
    } finally {
      globalThis.fetch = originalFetch;
      if (previousMode === undefined) delete process.env.BILLING_MODE; else process.env.BILLING_MODE = previousMode;
      if (previousKey === undefined) delete process.env.PAYMONGO_SECRET_KEY; else process.env.PAYMONGO_SECRET_KEY = previousKey;
    }
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
      const signingTime = String(Math.floor(Date.now() / 1000));
      const signature = 't=' + signingTime + ',' + (JSON.parse(raw).data.attributes.livemode ? 'li' : 'te') + '=' + createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(signingTime + '.').update(raw).digest('hex');
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
      const signingTime = String(Math.floor(Date.now() / 1000));
      const signature = 't=' + signingTime + ',' + (JSON.parse(raw).data.attributes.livemode ? 'li' : 'te') + '=' + createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(signingTime + '.').update(raw).digest('hex');
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
  await t.test('AI clarification keeps explicit facts, uses owned exact wallets, and stores short replies', async () => {
    const f = await fixture();
    await prisma.wallet.create({ data: { userId: f.user.id, name: 'GCash', openingBalance: 500, kind: 'ASSET' } });
    const first = await api(f.token, '/ai/chat', 'POST', { message: 'spent 100 on jeepney fare today' });
    assert.equal(first.status, 200);
    assert.equal(first.body.requiresClarification, true);
    assert.deepEqual(first.body.walletOptions, ['Cash', 'GCash']);
    const second = await api(f.token, '/ai/chat', 'POST', { message: "it's cash no wallet or account used", clarificationId: first.body.id });
    assert.equal(second.body.requiresConfirmation, true);
    const draft = await prisma.aiSession.findUniqueOrThrow({ where: { id: second.body.id } });
    assert.equal(draft.question, "it's cash no wallet or account used");
    assert.deepEqual(JSON.parse(JSON.stringify(draft.pendingAction)), {
      intent: 'LOG_TRANSACTION', amount: 100, transactionType: 'EXPENSE', category: 'Transport', description: 'jeepney fare today', date: 'today', walletName: 'Cash',
    });
    const confirmed = await api(f.token, '/ai/chat', 'POST', { message: 'confirm', confirmationId: second.body.id });
    assert.equal(confirmed.status, 200);
    const movement = await prisma.transaction.findFirstOrThrow({ where: { userId: f.user.id } });
    assert.equal(movement.walletId, f.wallet.id);
    assert.equal(Number(movement.amount), 100);
    assert.equal(movement.category, 'Transport');
    const replay = await api(f.token, '/ai/chat', 'POST', { message: 'confirm', confirmationId: second.body.id });
    assert.equal(replay.status, 200);
    assert.equal(await prisma.transaction.count({ where: { userId: f.user.id } }), 1);
  });
  await t.test('AI drafts survive quota errors and can be cancelled without a confirmation ID', async () => {
    const f = await fixture();
    const first = await api(f.token, '/ai/chat', 'POST', { message: 'spent 100 on fare today' });
    await prisma.usagePeriod.updateMany({ where: { userId: f.user.id }, data: { aiRequests: 10 } });
    assert.equal((await api(f.token, '/ai/chat', 'POST', { message: 'Cash', clarificationId: first.body.id })).status, 429);
    assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: first.body.id } })).state, 'NEEDS_CLARIFICATION');
    const cancelled = await api(f.token, '/ai/chat', 'POST', { message: 'cancel', clarificationId: first.body.id });
    assert.equal(cancelled.status, 200);
    assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: first.body.id } })).state, 'CANCELLED');
  });
  await t.test('unknown wallets prompt available accounts and legacy chat history is readable', async () => {
    const f = await fixture();
    const first = await api(f.token, '/ai/chat', 'POST', { message: 'spent 100 on fare from Missing Bank today' });
    assert.equal(first.body.requiresClarification, true);
    assert.deepEqual(first.body.walletOptions, ['Cash']);
    const second = await api(f.token, '/ai/chat', 'POST', { message: 'Cash', clarificationId: first.body.id });
    assert.equal(second.body.requiresConfirmation, true);
    await api(f.token, '/ai/chat', 'POST', { message: 'cancel', confirmationId: second.body.id });
    const legacy = await prisma.aiSession.create({ data: { userId: f.user.id, question: 'spent 100 on fare today. Additional detail: cash. Additional detail: 100', answer: 'Which wallet?', state: 'NEEDS_CLARIFICATION', model: 'test', promptTokens: 0, responseTokens: 0, totalTokens: 0, pendingAction: { intent: 'CLARIFY', amount: null } } });
    const history = await api(f.token, '/ai/history');
    assert.equal((history.body as unknown as Array<{ id: string; question: string }>).find(turn => turn.id === legacy.id)?.question, '100');
    const recovered = await api(f.token, '/ai/chat', 'POST', { message: 'Cash', clarificationId: legacy.id });
    assert.equal(recovered.body.requiresConfirmation, true);
    assert.match(recovered.body.content!, /₱100\.00.*Transport.*Cash.*today/);
    const stale = await api(f.token, '/ai/chat', 'POST', { message: 'cancel' });
    assert.equal(stale.status, 200);
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
