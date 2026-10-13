import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';

// Explicit disposable database only. Never use DATABASE_URL as a fallback.
// The provider is mocked; authentication, pgvector, financial reads, session
// writes and history reloads use the real production handlers and PostgreSQL.
test('RAG citations and planning context survive PostgreSQL chat/history round trips',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 }, async t => {
    const schema = 'casha_test_' + randomUUID().replaceAll('-', '');
    assert.match(schema, /^casha_test_[a-f0-9]{32}$/);
    const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    let schemaCreated = false;
    t.after(async () => {
      if (schemaCreated) {
        await db.query('SET search_path TO public');
        await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      await db.end();
    });
    await db.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await db.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    await db.query(`SET search_path TO "${schema}", public`);
    const baseline = (await readFile(new URL('../prisma/fresh-baseline.sql', import.meta.url), 'utf8'))
      .replace(/CREATE SCHEMA IF NOT EXISTS "public";/g, '')
      .replaceAll('"public".', `"${schema}".`);
    await db.query(baseline);
    await db.query(await readFile(new URL('../prisma/migrations/20261009090000_semantic_assistant_knowledge/migration.sql', import.meta.url), 'utf8'));

    process.env.TEST_DATABASE_SCHEMA = schema;
    process.env.JWT_ACCESS_SECRET = randomBytes(32).toString('hex');
    process.env.JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
    process.env.GEMINI_API_KEY = 'synthetic-rag-persistence-key';
    const { prisma } = await import('../src/lib/prisma');
    const { default: app } = await import('../src/app');
    const { loginUser } = await import('../src/services/auth');
    const { withFinancialOperation } = await import('../src/services/financialOperation');
    const { recordMovement } = await import('../src/services/movements');
    const { KnowledgeDocumentRepository } = await import('../src/repositories/knowledge.repository');
    const { contentHash } = await import('../src/utils/rag');
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/ai`;
    const originalFetch = globalThis.fetch;
    t.after(async () => {
      globalThis.fetch = originalFetch;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await prisma.$disconnect();
    });

    const vector = Array.from({ length: 768 }, (_, index) => Number(index === 0));
    const guide = { slug: 'test-savings', title: 'Fixture savings guide',
      content: 'Dedicated saved money differs from a planned savings allocation. A timeline assumes the stated contributions continue.',
      excerpt: 'Synthetic persistence fixture', category: ['savings'], isActive: true };
    const guideId = randomUUID();
    await new KnowledgeDocumentRepository().save(guide, vector, guideId);
    const source = { id: `document:${guideId}`, source: guide.title, version: contentHash(guide.title + '\n' + guide.content) };
    const password = 'RagFixture123!';
    const hash = await bcrypt.hash(password, 4);
    async function fixture() {
      const user = await prisma.user.create({ data: { email: randomUUID() + '@example.test', password: hash,
        firstName: 'RAG', lastName: 'Fixture', roles: [], localCredentialVerified: true, emailVerified: new Date() } });
      const wallet = await prisma.wallet.create({ data: { userId: user.id, name: 'Private Cash', openingBalance: 5000, kind: 'ASSET' } });
      return { user, wallet, token: (await loginUser({ email: user.email, password })).accessToken };
    }
    const a = await fixture(), b = await fixture();
    const now = new Date();
    await prisma.incomeSetup.create({ data: { userId: a.user.id, totalIncome: 10000, incomePeriod: 'monthly' } });
    await prisma.fixedExpense.create({ data: { userId: a.user.id, name: 'Private bill', amount: 700, frequency: 'ONE_TIME', dueDate: now } });
    await prisma.loan.create({ data: { userId: a.user.id, title: 'Private debt', type: 'BORROWED', amount: 2000,
      repaymentAmount: 100, repaymentFrequency: 'ONE_TIME', deadline: now, startDate: now, status: 'ACTIVE' } });
    await prisma.savingsGoal.create({ data: { userId: a.user.id, name: 'Emergency Fund', targetAmount: 10000, currentAmount: 2000, monthlyAllocation: 1000 } });
    await prisma.savingsGoal.create({ data: { userId: b.user.id, name: 'Other owner phone', targetAmount: 99999, currentAmount: 77777, monthlyAllocation: 9999 } });
    await withFinancialOperation(a.user.id, async tx => {
      await recordMovement(tx, a.user.id, { walletId: a.wallet.id, type: 'INCOME', amount: 3000, category: 'Salary', description: 'Private ledger income', date: now });
      await recordMovement(tx, a.user.id, { walletId: a.wallet.id, type: 'EXPENSE', amount: 500, category: 'Food & Dining', description: 'Private ledger spending', date: now });
    });

    let forged = false;
    const captured: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(base)) return originalFetch(input, init);
      assert.equal(new URL(url).hostname, 'generativelanguage.googleapis.com', 'Only the mocked Gemini endpoint may be contacted');
      if (url.includes(':batchEmbedContents')) return Response.json({ embeddings: [{ values: vector }] });
      const body = JSON.parse(String(init?.body));
      captured.push(JSON.stringify(body));
      const extraction = JSON.stringify(body.systemInstruction).includes('Extract a read-only');
      const result = extraction
        ? { operation: 'goal_timeline', language: 'en', parameters: [{ field: 'target', valueJson: '20000' }] }
        : { explanation: 'A savings timeline depends on continuing the planned contributions; allocations are distinct from money already saved.',
          sourceIds: [forged ? 'document:invented' : source.id] };
      return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } });
    };
    type Reply = { id: string; content: string; safeToSpend: number; requiresClarification: boolean;
      knowledgeSources: typeof source[]; calculation: { operation: string; values: Record<string, unknown> } };
    async function chat(token: string, message: string, clarificationId?: string) {
      const response = await originalFetch(base + '/chat', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...(clarificationId ? { clarificationId } : {}) }) });
      const reply = await response.json() as Reply;
      assert.equal(response.status, 200, JSON.stringify(reply));
      return reply;
    }
    async function history(token: string) {
      const response = await originalFetch(base + '/history', { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(response.status, 200);
      return response.json() as Promise<Array<{ id: string; knowledgeSources: typeof source[]; pendingAction: { plan: Record<string, unknown> } }>>;
    }

    assert.equal((await originalFetch(base + '/history')).status, 401);
    const first = await chat(a.token, 'How long to buy a phone worth PHP 20000?');
    assert.equal(first.requiresClarification, true);
    assert.equal(first.safeToSpend, 700);
    assert.equal(first.calculation.values.receivedIncome, 3000);
    assert.equal(first.calculation.values.recordedSpending, 500);
    assert.deepEqual(first.knowledgeSources, [source]);
    const stored = await prisma.aiSession.findUniqueOrThrow({ where: { id: first.id } });
    const metadata = stored.contextMetadata as { knowledgeSources: typeof source[]; retrieval: { mode: string }; calculation: { values: Record<string, unknown> } };
    assert.equal(stored.userId, a.user.id);
    assert.equal(metadata.retrieval.mode, 'semantic');
    assert.deepEqual(metadata.knowledgeSources, [source]);
    assert.equal(metadata.calculation.values.target, 20000);
    assert.deepEqual((await history(a.token)).at(-1)?.knowledgeSources, first.knowledgeSources);
    assert.deepEqual(await history(b.token), []);
    assert.ok(captured.every(body => !body.includes('Private Cash') && !body.includes('Private ledger') && !body.includes('Other owner phone')));

    // A fresh owner record must supersede the old amounts in recent history.
    await withFinancialOperation(a.user.id, tx => recordMovement(tx, a.user.id, { walletId: a.wallet.id, type: 'INCOME', amount: 200,
      category: 'Salary', description: 'Additional synthetic income', date: new Date() }));
    const saved = await chat(a.token, "I haven't saved anything yet", first.id);
    assert.equal(saved.calculation.values.saved, 0);
    assert.equal(saved.calculation.values.receivedIncome, 3200);
    assert.equal(saved.safeToSpend, 900);
    assert.equal((await prisma.aiSession.findUniqueOrThrow({ where: { id: first.id } })).state, 'COMPLETED');
    const reloaded = (await history(a.token)).at(-1)!;
    assert.equal(reloaded.pendingAction.plan.target, 20000);
    assert.equal(reloaded.pendingAction.plan.saved, 0);
    const complete = await chat(a.token, '1000, every month', reloaded.id);
    assert.equal(complete.requiresClarification, false);
    assert.equal(complete.calculation.values.periods, 20);
    assert.deepEqual(complete.knowledgeSources, [source]);
    assert.deepEqual((await history(a.token)).at(-1)?.knowledgeSources, complete.knowledgeSources);

    forged = true;
    const rejected = await chat(a.token, '1000, every month');
    assert.deepEqual(rejected.knowledgeSources, []);
    assert.deepEqual((await history(a.token)).at(-1)?.knowledgeSources, []);
    const rejectedRow = await prisma.aiSession.findUniqueOrThrow({ where: { id: rejected.id } });
    assert.doesNotMatch(JSON.stringify(rejectedRow.contextMetadata), /document:invented/);
    assert.equal(await prisma.transaction.count({ where: { userId: a.user.id } }), 3, 'Read-only planning must never create a financial movement');
    assert.equal(await prisma.aiSession.count({ where: { userId: b.user.id } }), 0);
  });
