import { prisma } from '@/lib/prisma';
import type { FinancialTx } from '@/services/financialOperation';
import { money, roundMoney } from '@/utils/money';
import { occurrencesBefore } from '@/utils/recurrence';

export interface SafeToSpendBreakdown {
  configuredIncome: number; actualIncome: number; totalIncome: number; totalFixed: number;
  totalSavings: number; totalExpenses: number; totalLoanRepayments: number;
  rawSafeToSpend: number; safeToSpend: number; periodStart: string; periodEnd: string;
}
// Configured income is a planning target. Safe-to-Spend represents money that
// has actually arrived, so expected pay never becomes spendable prematurely.
export function effectivePeriodIncome(configuredIncome: number, actualIncome: number) {
  void configuredIncome;
  return roundMoney(money(actualIncome));
}
export function periodRange(period: string, now = new Date()) {
  if (period === 'weekly') {
    const offset = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end };
  }
  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}
export function scheduledReserve(input: { amount: number; paid: number; due: Date | null; anchor?: Date | null; frequency: string; end: Date; remaining?: number }) {
  const count = input.due ? input.frequency === 'ONE_TIME' ? Number(input.due < input.end) : Math.max(0, occurrencesBefore(input.anchor ?? input.due, input.frequency, input.end) - occurrencesBefore(input.anchor ?? input.due, input.frequency, input.due)) : 1;
  return roundMoney(Math.min(input.remaining ?? Infinity, Math.max(0, count * input.amount - input.paid)));
}
export function savingsReserve(goals: Array<{ id: string; currentAmount: unknown; targetAmount: unknown; monthlyAllocation: unknown; isCompleted: boolean }>, movements: Array<{ type: string; amount: unknown; savingsGoalId: string | null }>, period: string) {
  const net = new Map<string, number>();
  for (const movement of movements) {
    if (!['SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL'].includes(movement.type)) continue;
    const id = movement.savingsGoalId ?? 'unlinked';
    net.set(id, roundMoney((net.get(id) ?? 0) + (movement.type === 'SAVINGS_WITHDRAWAL' ? -1 : 1) * money(movement.amount)));
  }
  let total = 0;
  for (const goal of goals) {
    const actual = Math.max(0, net.get(goal.id) ?? 0);
    const planned = goal.isCompleted ? 0 : money(goal.monthlyAllocation) / (period === 'weekly' ? 4.33 : 1);
    const remainingPlan = Math.min(Math.max(0, planned - actual), Math.max(0, money(goal.targetAmount) - money(goal.currentAmount)));
    total += actual + remainingPlan;
    net.delete(goal.id);
  }
  for (const amount of net.values()) total += Math.max(0, amount);
  return roundMoney(total);
}
export async function calculateSafeToSpendInTransaction(tx: FinancialTx, userId: string, now = new Date()): Promise<SafeToSpendBreakdown> {
  const setup = await tx.incomeSetup.findUnique({ where: { userId } });
  const { start, end } = periodRange(setup?.incomePeriod ?? 'monthly', now);
  const [bills, goals, movements, loans] = await Promise.all([
    tx.fixedExpense.findMany({ where: { userId, status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] }, OR: [{ dueDate: { lt: end } }, { dueDate: null }] } }),
    tx.savingsGoal.findMany({ where: { userId } }),
    tx.transaction.findMany({ where: { userId, deletedAt: null, date: { gte: start, lt: end } }, select: { type: true, amount: true, savingsGoalId: true } }),
    tx.loan.findMany({ where: { userId, type: 'BORROWED', status: { in: ['ACTIVE', 'OVERDUE'] }, deadline: { lt: end } } }),
  ]);
  const totals = new Map<string, number>();
  for (const row of movements) totals.set(row.type, (totals.get(row.type) ?? 0) + money(row.amount));
  const actualIncome = totals.get('INCOME') ?? 0;
  const configuredIncome = money(setup?.totalIncome);
  const totalIncome = effectivePeriodIncome(configuredIncome, actualIncome);
  const totalFixed = roundMoney(bills.reduce((sum, bill) => sum + scheduledReserve({ amount: money(bill.amount), paid: money(bill.amountPaid), due: bill.dueDate, anchor: bill.scheduleAnchor, frequency: bill.frequency, end }), 0));
  const totalLoanRepayments = roundMoney(loans.reduce((sum, loan) => sum + scheduledReserve({ amount: money(loan.repaymentAmount) || money(loan.amount), paid: money(loan.installmentPaid), due: loan.deadline, anchor: loan.scheduleAnchor, frequency: loan.repaymentFrequency, end, remaining: Math.max(0, money(loan.amount) - money(loan.amountPaid)) }), 0));
  const totalSavings = savingsReserve(goals, movements, setup?.incomePeriod ?? 'monthly');
  const totalExpenses = roundMoney(['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'].reduce((sum, type) => sum + (totals.get(type) ?? 0), 0));
  const rawSafeToSpend = roundMoney(totalIncome - totalFixed - totalSavings - totalLoanRepayments - totalExpenses);
  return { configuredIncome, actualIncome: roundMoney(actualIncome), totalIncome: roundMoney(totalIncome), totalFixed, totalSavings, totalExpenses, totalLoanRepayments, rawSafeToSpend, safeToSpend: Math.max(0, rawSafeToSpend), periodStart: start.toISOString(), periodEnd: end.toISOString() };
}
export const calculateSafeToSpend = (userId: string, now = new Date()) => prisma.$transaction(tx => calculateSafeToSpendInTransaction(tx, userId, now), { isolationLevel: 'RepeatableRead' });
// Calculated on demand: a stored allowance becomes stale after period rollover.
export async function recalculateSafeToSpend(userId: string) { return (await calculateSafeToSpend(userId)).safeToSpend; }
export const getSafeToSpend = recalculateSafeToSpend;
