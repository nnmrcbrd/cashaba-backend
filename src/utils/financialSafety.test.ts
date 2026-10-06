import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceDate, occurrencesBefore } from './recurrence';
import { effectivePeriodIncome, scheduledReserve, savingsReserve } from './safeToSpend';
import { reportMonths, periodForecast } from './reportingPeriod';
import { movementSchema } from '@/schema/movement';
import { calculateWalletBalance } from '@/controllers/wallet.controller';
import { signRefreshToken } from '@/services/auth';
import { parseBankCSV } from './gcashParser';

test('Safe-to-Spend uses recorded income while configured income remains a plan', () => {
  assert.equal(effectivePeriodIncome(30_000, 0), 0);
  assert.equal(effectivePeriodIncome(30_000, 1_000), 1_000);
  assert.equal(effectivePeriodIncome(30_000, 30_000), 30_000);
  assert.equal(effectivePeriodIncome(30_000, 32_500.125), 32_500.13);
});

test('month-end recurrence retains its original day, including leap years', () => {
  const anchor = new Date(2026, 0, 31, 12);
  assert.equal(occurrenceDate(anchor, 'MONTHLY').getDate(), 28);
  assert.equal(occurrenceDate(anchor, 'MONTHLY', 2).getDate(), 31);
  assert.equal(occurrenceDate(new Date(2024, 1, 29), 'YEARLY').getDate(), 28);
  assert.equal(occurrencesBefore(new Date(2026, 8, 1), 'WEEKLY', new Date(2026, 9, 1)), 5);
});
test('reserves all installments and arrears, capped at the remaining loan', () => {
  const base = { amount: 100, paid: 30, due: new Date(2026, 8, 1), frequency: 'WEEKLY', end: new Date(2026, 9, 1) };
  assert.equal(scheduledReserve(base), 470);
  assert.equal(scheduledReserve({ ...base, remaining: 250 }), 250);
  assert.equal(scheduledReserve({ ...base, frequency: 'ONE_TIME' }), 70);
  assert.equal(scheduledReserve({ ...base, due: new Date(2026, 7, 25) }), 570);
});
test('completed goals and above-plan contributions stay reserved without double counting', () => {
  const goal = { id: 'goal', currentAmount: 100, targetAmount: 100, monthlyAllocation: 100, isCompleted: true };
  const row = { type: 'SAVINGS_CONTRIBUTION', savingsGoalId: 'goal', amount: 100 };
  assert.equal(savingsReserve([goal], [row], 'monthly'), 100);
  assert.equal(savingsReserve([{ ...goal, targetAmount: 1000, isCompleted: false }], [{ ...row, amount: 150 }], 'monthly'), 150);
  assert.equal(savingsReserve([{ ...goal, currentAmount: 40, targetAmount: 1000, isCompleted: false }], [{ ...row, amount: 40 }], 'monthly'), 100);
});
test('rejects unrelated links, missing linked targets and fractional cents', () => {
  const base = { type: 'INCOME', description: 'Salary', category: 'Salary', amount: 100, date: '2026-09-25', walletId: '11111111-1111-4111-8111-111111111111' };
  assert.equal(movementSchema.safeParse(base).success, true);
  for (const field of ['destinationWalletId', 'savingsGoalId', 'fixedExpenseId', 'loanId']) assert.equal(movementSchema.safeParse({ ...base, [field]: '22222222-2222-4222-8222-222222222222' }).success, false);
  assert.equal(movementSchema.safeParse({ ...base, type: 'BILL_PAYMENT' }).success, false);
  assert.equal(movementSchema.safeParse({ ...base, amount: 0.001 }).success, false);
});
test('wallets preserve negative balances and liability overpayments', () => {
  assert.equal(calculateWalletBalance({ openingBalance: 100, kind: 'ASSET', transactions: [{ type: 'EXPENSE', category: 'Food', amount: 150 }], incomingTransfers: [] }), -50);
  assert.equal(calculateWalletBalance({ openingBalance: 100, kind: 'LIABILITY', transactions: [], incomingTransfers: [{ amount: 150 }] }), -50);
});
test('completed historical periods do not shrink as time passes; monthly budgets prorate', () => {
  const start = new Date(2026, 7, 1), end = new Date(2026, 8, 1); end.setMilliseconds(-1);
  assert.equal(periodForecast(1000, start, end, new Date(2026, 8, 25)), 1000);
  assert.equal(periodForecast(1000, start, end, new Date(2027, 0, 1)), 1000);
  const full = reportMonths(new Date('2026-01-01T00:00:00+08:00'), new Date('2026-02-28T23:59:59.999+08:00'));
  assert.deepEqual(full.map(value => value.fraction), [1, 1]);
  assert.equal(reportMonths(new Date('2026-09-01T00:00:00+08:00'), new Date('2026-09-07T23:59:59.999+08:00'))[0].fraction, 7 / 30);
});
test('refresh tokens have independent random identities even within one second', () => {
  const old = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_REFRESH_SECRET = 'test-only-secret-never-used-for-production';
  try { assert.notEqual(signRefreshToken('user', 'LOCAL', 0), signRefreshToken('user', 'LOCAL', 0)); }
  finally { if (old === undefined) delete process.env.JWT_REFRESH_SECRET; else process.env.JWT_REFRESH_SECRET = old; }
});
test('CSV contract supports signed amounts and debit/credit, rejects ambiguous dates', async () => {
  assert.equal((await parseBankCSV(Buffer.from('Date,Description,Debit,Credit\n2026-09-25,Food,100,\n')))[0].amount, -100);
  assert.equal((await parseBankCSV(Buffer.from('Date,Description,Amount\n2026-09-25,Salary,200\n')))[0].amount, 200);
  await assert.rejects(() => parseBankCSV(Buffer.from('Date,Description,Amount\n09/25/2026,Food,-100\n')));
  await assert.rejects(() => parseBankCSV(Buffer.from('Date,Description,Debit,Credit\n2026-09-25,Food,100,100\n')));
});
