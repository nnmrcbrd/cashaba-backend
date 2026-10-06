import { prisma } from '@/lib/prisma';
import { businessMonth } from '@/utils/calendar';
import { calculateSafeToSpendInTransaction } from '@/utils/safeToSpend';
import { money, roundMoney } from '@/utils/money';
import { calculateWalletBalance } from '@/controllers/wallet.controller';
import type { AdviceFacts } from '@/utils/personalFinanceAdvice';

export async function loadAdviceFacts(userId: string, now = new Date()): Promise<AdviceFacts> {
  const month = businessMonth(now);
  return prisma.$transaction(async tx => {
    const breakdown = await calculateSafeToSpendInTransaction(tx, userId, now);
    const [setup, goals, budget, spending, accounts, loans, bills] = await Promise.all([
      tx.incomeSetup.findUnique({ where: { userId } }),
      tx.savingsGoal.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      tx.budget.findUnique({ where: { userId_month_year: { userId, month: month.month, year: month.year } } }),
      tx.transaction.aggregate({ where: { userId, deletedAt: null, type: { in: ['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'] }, date: { gte: month.start, lt: month.end } }, _sum: { amount: true } }),
      tx.wallet.findMany({ where: { userId }, include: { transactions: { where: { deletedAt: null }, select: { type: true, amount: true, category: true } }, incomingTransfers: { where: { deletedAt: null, type: 'TRANSFER' }, select: { amount: true } } } }),
      tx.loan.findMany({ where: { userId, status: { in: ['ACTIVE', 'OVERDUE'] } } }),
      tx.fixedExpense.findMany({ where: { userId, status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] } } }),
    ]);
    return {
      breakdown, incomePeriod: setup?.incomePeriod === 'weekly' ? 'weekly' : 'monthly',
      goals: goals.map(goal => ({ name: goal.name, saved: money(goal.currentAmount), target: money(goal.targetAmount), monthlyAllocation: money(goal.monthlyAllocation) })),
      budget: budget ? { target: money(budget.targetAmount), spent: money(spending._sum.amount) } : null,
      accounts: accounts.map(account => ({ name: account.name, kind: account.kind, balance: calculateWalletBalance(account) })),
      loans: loans.map(loan => ({ name: loan.title, type: loan.type, remaining: roundMoney(Math.max(0, money(loan.amount) - money(loan.amountPaid))) })),
      bills: bills.map(bill => ({ name: bill.name, remaining: roundMoney(Math.max(0, money(bill.amount) - money(bill.amountPaid))) })),
    };
  }, { isolationLevel: 'RepeatableRead' });
}
