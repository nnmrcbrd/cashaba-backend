import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { prisma } from '@/lib/prisma';
import { getAiHistory, processAiChat } from './aiCommand.controller';

// Exercise the actual handler, usage accounting, fact loader, calculator and
// saved-session transitions. Only persistence is replaced; no private database
// or provider is used, and a ledger write fails the test immediately.
test('the screenshot conversation survives persisted sessions and history reloads', async t => {
  const owner = 'screenshot-owner';
  const sessions: any[] = [];
  let spending = 1500, factReads = 0, charges = 0;
  const now = new Date();
  const assertOwner = (args: any) => assert.equal(args.where.userId ?? args.where.userId_month_year?.userId, owner);
  const sessionStore = {
    findFirst: async (args: any) => {
      assertOwner(args);
      return structuredClone(sessions.findLast(row => args.where.state.in.includes(row.state)) ?? null);
    },
    findMany: async (args: any) => {
      assertOwner(args);
      return structuredClone(sessions.slice(-args.take).reverse());
    },
    updateMany: async (args: any) => {
      assertOwner(args);
      let count = 0;
      for (const row of sessions) if ((!args.where.id || row.id === args.where.id) && row.state === args.where.state) {
        Object.assign(row, args.data); count++;
      }
      return { count };
    },
    create: async ({ data }: any) => {
      assert.equal(data.userId, owner);
      const row = { ...structuredClone(data), pendingAction: data.pendingAction ? JSON.parse(JSON.stringify(data.pendingAction)) : null,
        id: `session-${sessions.length + 1}`, createdAt: new Date(now.getTime() + sessions.length) };
      sessions.push(row);
      return structuredClone(row);
    },
  };
  const scopedRead = (result: () => unknown) => async (args: any) => { assertOwner(args); return result(); };
  const tx = {
    user: { findUniqueOrThrow: async () => ({ trialStartedAt: now }) },
    $queryRawUnsafe: async (_sql: string, userId: string) => { assert.equal(userId, owner); return [{ id: owner }]; },
    subscription: { findUnique: scopedRead(() => null) },
    usagePeriod: {
      upsert: async (args: any) => { assert.equal(args.where.userId_periodStart.userId, owner); return { id: 'test-usage', aiRequests: charges }; },
      update: async () => ({ id: 'test-usage', aiRequests: ++charges }),
    },
    aiSession: sessionStore,
    incomeSetup: { findUnique: scopedRead(() => { factReads++; return { totalIncome: 30000, incomePeriod: 'monthly' }; }) },
    savingsGoal: { findMany: scopedRead(() => [{ id: 'general-goal', name: 'Emergency Fund', currentAmount: 0, targetAmount: 10000, monthlyAllocation: 1000, isCompleted: false }]) },
    fixedExpense: { findMany: scopedRead(() => [{ name: 'Bills', amount: 2999, amountPaid: 0, status: 'PENDING', dueDate: now, frequency: 'ONE_TIME' }]) },
    loan: { findMany: scopedRead(() => [{ title: 'Debt', type: 'BORROWED', amount: 5000, amountPaid: 0, repaymentAmount: 500, installmentPaid: 0, deadline: now, repaymentFrequency: 'ONE_TIME' }]) },
    wallet: { findMany: scopedRead(() => [{ name: 'Cash', kind: 'ASSET', accountType: 'CASH', initialBalance: 25000, transactions: [], incomingTransfers: [] }]) },
    budget: { findUnique: scopedRead(() => ({ targetAmount: 5000 })) },
    transaction: {
      findMany: scopedRead(() => [{ type: 'EXPENSE', amount: spending, savingsGoalId: null }]),
      aggregate: scopedRead(() => ({ _sum: { amount: spending } })),
      groupBy: scopedRead(() => [{ date: now, category: 'Food & Dining', type: 'EXPENSE', _sum: { amount: spending } }]),
      findFirst: scopedRead(() => ({ date: now })), count: scopedRead(() => 1),
      create: async () => { assert.fail('A savings scenario must not write to the ledger'); },
    },
  };
  // Prisma exposes these methods through a proxy, rather than own descriptors.
  const original = { transaction: prisma.$transaction, first: prisma.aiSession.findFirst,
    many: prisma.aiSession.findMany, wallets: prisma.wallet.findMany };
  prisma.$transaction = (async (callback: (client: unknown) => unknown) => callback(tx)) as typeof prisma.$transaction;
  prisma.aiSession.findFirst = sessionStore.findFirst as typeof prisma.aiSession.findFirst;
  prisma.aiSession.findMany = sessionStore.findMany as typeof prisma.aiSession.findMany;
  prisma.wallet.findMany = tx.wallet.findMany as typeof prisma.wallet.findMany;
  t.after(() => { prisma.$transaction = original.transaction; prisma.aiSession.findFirst = original.first;
    prisma.aiSession.findMany = original.many; prisma.wallet.findMany = original.wallets; });
  const key = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => { if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; });
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('This deterministic flow must not call a provider'); });
  const invoke = async (handler: (req: Request, res: Response) => Promise<unknown>, body: Record<string, unknown> = {}) => {
    let status = 200, payload: any;
    const response = { status: (code: number) => { status = code; return response; }, json: (value: unknown) => { payload = value; return response; } };
    await handler({ user: { userId: owner }, body, query: {} } as Request, response as unknown as Response);
    assert.equal(status, 200, JSON.stringify(payload));
    return payload;
  };
  const first = await invoke(processAiChat, { message: 'how long will it take for me to buy the latest iphone 18 pro max? iphone 18 pro max 2TB: ₱194,990.00' });
  assert.equal(first.calculation.values.target, 194990);
  assert.equal(first.calculation.values.receivedIncome, 0, 'Expected income must not become received income');
  assert.equal(first.calculation.values.recordedSpending, 1500);
  assert.match(first.content, /How much is already saved specifically for this target/);
  assert.equal(first.clarificationType, 'planning');
  assert.deepEqual(first.knowledgeSources, []);
  assert.equal(sessions[0].contextMetadata.calculation.operation, 'goal_timeline');
  assert.equal(sessions[0].contextMetadata.calculation.values.target, 194990);
  assert.equal(sessions[0].contextMetadata.retrieval.mode, 'unavailable');
  assert.deepEqual(sessions[0].contextMetadata.knowledgeSources, []);
  const second = await invoke(processAiChat, { message: 'I HAVENT SAVE ANYTHING YET', clarificationId: first.id });
  assert.equal(second.calculation.values.saved, 0);
  assert.equal(second.requiresClarification, true);
  assert.equal(sessions[0].state, 'COMPLETED');
  const acceptedSource = { id: 'document:test-guide', source: 'Fixture savings guide', version: 'test-version' };
  // Simulate a previously accepted, persisted citation; history must retain it.
  sessions[1].contextMetadata.knowledgeSources = [acceptedSource];
  const reloaded = await invoke(getAiHistory);
  assert.equal(reloaded.at(-1).id, second.id);
  assert.equal(reloaded.at(-1).state, 'NEEDS_CLARIFICATION');
  assert.equal(reloaded.at(-1).clarificationType, 'planning');
  assert.equal(reloaded.at(-1).pendingAction.plan.target, 194990);
  assert.equal(reloaded.at(-1).pendingAction.plan.saved, 0);
  assert.deepEqual(reloaded.at(-1).knowledgeSources, sessions[1].contextMetadata.knowledgeSources);
  assert.deepEqual(reloaded.at(-1).knowledgeSources, [acceptedSource]);
  const final = await invoke(processAiChat, { message: '1000, EVERY MONTH', clarificationId: reloaded.at(-1).id });
  assert.equal(final.calculation.operation, 'goal_timeline');
  assert.equal(final.calculation.values.periods, 195);
  assert.equal(final.calculation.values.contribution, 1000);
  assert.equal(final.calculation.values.saved, 0);
  assert.equal(final.requiresClarification, false);
  assert.equal(final.clarificationType, null);
  assert.deepEqual(final.calculation.missing, []);
  assert.match(final.content, /195 monthly contribution/);
  assert.match(final.content, /16 year\(s\) and 3 month\(s\)/);
  assert.doesNotMatch(final.content, /How much can you afford to save per contribution/);
  assert.equal(sessions[1].state, 'COMPLETED');
  assert.equal(sessions[2].state, 'COMPLETED');
  assert.equal(sessions[2].pendingAction.plan.frequency, 'monthly');
  assert.equal(charges, 3);
  assert.equal(factReads, 6, 'Both the shared balance and planning facts reload on every turn');
  spending = 1600;
  const correction = await invoke(processAiChat, { message: '1000, every month' });
  assert.equal(correction.calculation.values.recordedSpending, 1600);
  assert.equal(correction.calculation.values.periods, 195);
});
