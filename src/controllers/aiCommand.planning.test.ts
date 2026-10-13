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
    // The screenshot account has Plus access. Keep sufficient fixture usage for
    // the longer read-only regression conversation; no real quota is changed.
    subscription: { findUnique: scopedRead(() => ({ plan: 'PLUS', status: 'ACTIVE', currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000) })) },
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
  const originalProfile = prisma.user.findUniqueOrThrow;
  prisma.user.findUniqueOrThrow = (async (args: any) => {
    assert.deepEqual(args, { where: { id: owner }, select: { firstName: true, lastName: true } });
    return { firstName: 'Synthetic', lastName: 'Owner' };
  }) as typeof prisma.user.findUniqueOrThrow;
  t.after(() => { prisma.user.findUniqueOrThrow = originalProfile; });
  const identity = await invoke(processAiChat, { message: 'Who am I?', userId: 'another-owner' });
  assert.match(identity.content, /You are Synthetic Owner/);
  assert.equal(identity.model, 'local-account-identity-v1');
  assert.deepEqual(identity.knowledgeSources, []);
  assert.equal(sessions.at(-1).userId, owner);
  const phone = await invoke(processAiChat, { message: 'how long will it take for me to buy latest iphone 18 promax 194,000 if i save 10000 a month' });
  assert.equal(phone.calculation.values.target, 194000);
  assert.equal(phone.calculation.values.contribution, 10000);
  assert.deepEqual(phone.calculation.missing, ['saved_balance']);
  const profileDuringPlan = await invoke(processAiChat, { message: 'kinsa ko?' });
  assert.match(profileDuringPlan.content, /Ikaw si Synthetic Owner/);
  assert.equal(profileDuringPlan.requiresClarification, true);
  assert.equal(profileDuringPlan.clarificationType, 'planning');
  assert.equal(profileDuringPlan.id, phone.id);
  assert.equal(sessions.find(row => row.id === phone.id).state, 'NEEDS_CLARIFICATION');
  const zero = await invoke(processAiChat, { message: 'I have not saved anything yet', clarificationId: phone.id });
  assert.equal(zero.calculation.values.periods, 20);
  assert.deepEqual(zero.calculation.missing, []);
  const explanation = await invoke(processAiChat, { message: 'nganong 0 ang safe to spend?' });
  assert.match(explanation.content, /received income ₱0\.00/);
  assert.doesNotMatch(explanation.content, /next confirmed payday|I can help with/);
  const savedProfile = (await invoke(getAiHistory)).find((row: any) => row.model === 'local-account-identity-v1');
  assert.ok(savedProfile);
  assert.match(savedProfile.answer, /Synthetic Owner/);
  // Copying the suggested samples includes their quotes/list markers. Preserve
  // the exact original text while routing by the normalized read-only question.
  const copiedIdentity = '“Who am I? Use my saved profile in this system.”';
  const copiedProfile = await invoke(processAiChat, { message: copiedIdentity, userId: 'another-owner' });
  assert.match(copiedProfile.content, /You are Synthetic Owner/);
  assert.equal(copiedProfile.model, 'local-account-identity-v1');
  assert.equal(sessions.at(-1).question, copiedIdentity);
  const copiedPhone = '1. “My phone target costs ₱194,000. I have saved ₱0 for it. If I save ₱10,000 every month, how many contributions will I need?”';
  const completePhone = await invoke(processAiChat, { message: copiedPhone });
  assert.equal(completePhone.calculation.operation, 'goal_timeline');
  assert.equal(completePhone.calculation.values.periods, 20);
  assert.equal(completePhone.calculation.values.saved, 0);
  assert.equal(completePhone.requiresClarification, false);
  assert.equal(sessions.at(-1).question, copiedPhone);
  const increased = await invoke(processAiChat, { message: '“What if I save ₱15,000 monthly instead?”' });
  assert.equal(increased.calculation.values.target, 194000);
  assert.equal(increased.calculation.values.saved, 0);
  assert.equal(increased.calculation.values.periods, 13);
  const namedDate = await invoke(processAiChat, { message: '“My first contribution will be on October 15, 2026. What is my completion date?”' });
  assert.equal(namedDate.calculation.values.completionDate, '2027-10-15');
  const copiedHistory = await invoke(getAiHistory);
  assert.equal(copiedHistory.at(-1).contextMetadata.calculation.values.completionDate, '2027-10-15');
  assert.equal(copiedHistory.at(-1).pendingAction.plan.target, 194000);
  assert.equal(copiedHistory.at(-1).pendingAction.plan.contribution, 15000);

  // The frustrated follow-ups in the latest screenshots must use the actual
  // preceding usage question, including after a database/history reload.
  const usage = await invoke(processAiChat, { message: 'how to use casha-ba?' });
  assert.match(usage.content, /Money → Wallet & Accounts/);
  for (const message of ['im asking', 'stupid']) {
    const retry = await invoke(processAiChat, { message });
    assert.match(retry.content, /Money → Wallet & Accounts/, message);
    assert.doesNotMatch(retry.content, /What would you like|I apologize|I am here to help/, message);
    assert.equal(sessions.at(-1).pendingAction.originalQuestion, 'how to use casha-ba?');
    const history = await invoke(getAiHistory);
    assert.equal(history.at(-1).pendingAction.originalQuestion, 'how to use casha-ba?');
  }
  const preview = { id: 'unconfirmed-expense', userId: owner, question: 'Spent 100 on fare from Cash today',
    answer: 'Expense: ₱100.00 · Transport · Cash · today', state: 'AWAITING_CONFIRMATION', createdAt: now,
    pendingAction: { intent: 'LOG_TRANSACTION', type: 'EXPENSE', amount: 100, category: 'Transport', walletName: 'Cash' } };
  sessions.push(preview);
  for (const message of ['im asking', 'stupid']) {
    const reply = await invoke(processAiChat, { message });
    assert.equal(reply.id, preview.id);
    assert.equal(reply.requiresConfirmation, true);
    assert.match(reply.content, /No money or records have changed yet/);
    assert.match(reply.content, /Your action is still awaiting confirmation/);
    assert.equal(preview.state, 'AWAITING_CONFIRMATION', 'Frustration is not confirmation');
  }
});
