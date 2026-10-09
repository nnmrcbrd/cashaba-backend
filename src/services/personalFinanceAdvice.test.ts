import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { loadAdviceFacts } from './personalFinanceAdvice';
import { calculateSafeToSpendInTransaction } from '@/utils/safeToSpend';
import type { FinancialTx } from './financialOperation';
import { reserveAiTokens } from './aiRuntime';
import { authorize } from '@/middlewares/rbac.middleware';
import type { Request, Response } from 'express';

test('every planning snapshot query, including wallet relations, is scoped to the authenticated owner', async () => {
  const original = prisma.$transaction;
  const calls: Array<{ model: string; method: string; args: any }> = [];
  const models = ['incomeSetup', 'savingsGoal', 'budget', 'transaction', 'wallet', 'loan', 'fixedExpense'];
  const tx = Object.fromEntries(models.map(model => [model, Object.fromEntries(['findUnique', 'findFirst', 'findMany', 'aggregate', 'groupBy', 'count'].map(method => [method, async (args: unknown) => {
    calls.push({ model, method, args });
    if (method === 'findUnique' || method === 'findFirst') return null;
    if (method === 'aggregate') return { _sum: { amount: null } };
    return method === 'count' ? 0 : [];
  }]))]));
  prisma.$transaction = (async (callback: (client: unknown) => unknown) => callback(tx)) as typeof prisma.$transaction;
  try {
    const facts = await loadAdviceFacts('owner-a', new Date('2026-10-08T04:00:00Z'));
    assert.equal(facts.planning?.recordCount, 0);
    for (const call of calls) {
      assert.equal(call.args.where.userId ?? call.args.where.userId_month_year?.userId, 'owner-a', `${call.model}.${call.method}`);
      if (call.model === 'wallet') {
        assert.equal(call.args.include.transactions.where.userId, 'owner-a');
        assert.equal(call.args.include.incomingTransfers.where.userId, 'owner-a');
      }
    }
    assert.ok(calls.some(call => call.method === 'groupBy'));
    assert.ok(calls.filter(call => call.model === 'transaction' && ['groupBy', 'findFirst', 'count', 'findMany'].includes(call.method)).every(call => call.args.where.date.lte));
  } finally { prisma.$transaction = original; }
});
test('Safe-to-Spend excludes transfers/loan principal and deducts bill and savings payments once', async () => {
  const tx = {
    incomeSetup: { findUnique: async () => ({ incomePeriod: 'monthly', totalIncome: 99999 }) },
    fixedExpense: { findMany: async () => [{ amount: 1000, amountPaid: 400, dueDate: new Date('2026-10-10'), frequency: 'ONE_TIME' }] },
    savingsGoal: { findMany: async () => [{ id: 'goal', targetAmount: 10000, currentAmount: 300, monthlyAllocation: 500, isCompleted: false }] },
    loan: { findMany: async () => [{ amount: 2000, amountPaid: 100, repaymentAmount: 500, installmentPaid: 100, deadline: new Date('2026-10-12'), repaymentFrequency: 'ONE_TIME' }] },
    transaction: { findMany: async (args: any) => {
      assert.equal(args.where.deletedAt, null); assert.equal(args.where.date.lte.toISOString(), '2026-10-08T04:00:00.000Z');
      return [
        { type: 'INCOME', amount: 5000 }, { type: 'EXPENSE', amount: 1000 },
        { type: 'BILL_PAYMENT', amount: 400 }, { type: 'DEBT_PAYMENT', amount: 100 },
        { type: 'SAVINGS_CONTRIBUTION', amount: 300, savingsGoalId: 'goal' },
        { type: 'TRANSFER', amount: 10000 }, { type: 'LOAN_PROCEEDS', amount: 2000 },
        { type: 'LOAN_COLLECTION', amount: 2000 },
      ];
    } },
  } as unknown as FinancialTx;
  const result = await calculateSafeToSpendInTransaction(tx, 'owner-a', new Date('2026-10-08T04:00:00Z'));
  assert.equal(result.totalIncome, 5000); assert.equal(result.totalFixed, 600);
  assert.equal(result.totalLoanRepayments, 400); assert.equal(result.totalSavings, 500);
  assert.equal(result.totalExpenses, 1500); assert.equal(result.safeToSpend, 2000);
});
test('global budget reservation is atomic and does not insert above-cap first reservations', async () => {
  const original = prisma.$queryRawUnsafe;
  let sql = '', args: unknown[] = [];
  prisma.$queryRawUnsafe = (async (query: string, ...values: unknown[]) => { sql = query; args = values; return []; }) as typeof prisma.$queryRawUnsafe;
  try {
    await assert.rejects(reserveAiTokens(999999999, new Date('2026-10-08T00:00:00Z')), /GLOBAL_BUDGET/);
    assert.match(sql, /SELECT \$1::text, \$2::integer/);
    assert.match(sql, /WHERE \$2::integer <= \$3::integer/); assert.match(sql, /bucket\."hits" \+ \$2::integer <= \$3::integer/);
    assert.equal(args[0], 'ai-token-cap:2026-10-08');
  } finally { prisma.$queryRawUnsafe = original; }
});
test('admins remain barred from the private financial assistant', () => {
  let status = 0, next = false;
  authorize(['USER'])({ user: { userId: 'admin-a', accountRole: 'ADMIN' } } as Request,
    { status: (value: number) => { status = value; return { json: () => {} }; } } as unknown as Response, () => { next = true; });
  assert.equal(status, 403); assert.equal(next, false);
});
