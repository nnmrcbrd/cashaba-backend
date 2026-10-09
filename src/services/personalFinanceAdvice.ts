import { prisma } from '@/lib/prisma';
import { businessMonth, businessDateLabel } from '@/utils/calendar';
import { calculateSafeToSpendInTransaction } from '@/utils/safeToSpend';
import { money, roundMoney } from '@/utils/money';
import { calculateWalletBalance } from '@/controllers/wallet.controller';
import type { AdviceFacts } from '@/utils/personalFinanceAdvice';

export async function loadAdviceFacts(userId: string, now = new Date()): Promise<AdviceFacts> {
  const month = businessMonth(now);
  return prisma.$transaction(async tx => {
    const breakdown = await calculateSafeToSpendInTransaction(tx, userId, now);
    const historyStart = new Date(month.start); historyStart.setUTCFullYear(historyStart.getUTCFullYear() - 1);
    const [setup, goals, budget, spending, accounts, loans, bills, history, firstRecord, recordCount] = await Promise.all([
      tx.incomeSetup.findUnique({ where: { userId } }),
      tx.savingsGoal.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      tx.budget.findUnique({ where: { userId_month_year: { userId, month: month.month, year: month.year } } }),
      tx.transaction.aggregate({ where: { userId, deletedAt: null, type: { in: ['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'] }, date: { gte: month.start, lte: now, lt: month.end } }, _sum: { amount: true } }),
      tx.wallet.findMany({ where: { userId }, include: { transactions: { where: { userId, deletedAt: null, date: { lte: now } }, select: { type: true, amount: true, category: true } }, incomingTransfers: { where: { userId, deletedAt: null, type: 'TRANSFER', date: { lte: now } }, select: { amount: true } } } }),
      tx.loan.findMany({ where: { userId, status: { in: ['ACTIVE', 'OVERDUE'] } } }),
      tx.fixedExpense.findMany({ where: { userId } }),
      tx.transaction.groupBy({ by: ['date', 'category', 'type'], where: { userId, deletedAt: null, date: { gte: historyStart, lte: now }, type: { in: ['INCOME', 'EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT', 'SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL'] } }, _sum: { amount: true } }),
      tx.transaction.findFirst({ where: { userId, deletedAt: null, date: { lte: now } }, orderBy: { date: 'asc' }, select: { date: true } }),
      tx.transaction.count({ where: { userId, deletedAt: null, date: { gte: historyStart, lte: now } } }),
    ]);
    return {
      breakdown, incomePeriod: setup?.incomePeriod === 'weekly' ? 'weekly' : 'monthly',
      goals: goals.map(goal => ({ name: goal.name, saved: money(goal.currentAmount), target: money(goal.targetAmount), monthlyAllocation: money(goal.monthlyAllocation) })),
      budget: budget ? { target: money(budget.targetAmount), spent: money(spending._sum.amount) } : null,
      accounts: accounts.map(account => ({ name: account.name, kind: account.kind, accountType: account.accountType, balance: calculateWalletBalance(account) })),
      loans: loans.map(loan => ({ name: loan.title, type: loan.type, remaining: roundMoney(Math.max(0, money(loan.amount) - money(loan.amountPaid))) })),
      bills: bills.filter(bill => ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(bill.status)).map(bill => ({ name: bill.name, remaining: roundMoney(Math.max(0, money(bill.amount) - money(bill.amountPaid))) })),
      planning: {
        asOf: now.toISOString(), currency: 'PHP', timezone: 'Asia/Manila',
        historyStart: businessDateLabel(historyStart), historyEnd: businessDateLabel(now),
        firstRecord: firstRecord ? businessDateLabel(firstRecord.date) : null, recordCount,
        nextPayday: null, lastPayday: null, essentialDaily: null, protectedCash: null, recordsComplete: false,
        spending: history.map(row => ({ date: businessDateLabel(row.date), category: row.category, type: row.type, amount: money(row._sum.amount) })),
        obligations: bills.filter(bill => ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'].includes(bill.status)).map(row => ({ name: row.name, amount: money(row.amount), paid: money(row.amountPaid), due: row.dueDate ? businessDateLabel(row.dueDate) : null, anchor: row.scheduleAnchor ? businessDateLabel(row.scheduleAnchor) : null, frequency: row.frequency })),
        recurringObligations: bills.filter(row => row.frequency !== 'ONE_TIME').map(row => ({ name: row.name, amount: money(row.amount), frequency: row.frequency })),
        debts: loans.map(row => ({ name: row.title, type: row.type, remaining: roundMoney(Math.max(0, money(row.amount) - money(row.amountPaid))), payment: money(row.repaymentAmount), paid: money(row.installmentPaid), due: businessDateLabel(row.deadline), anchor: row.scheduleAnchor ? businessDateLabel(row.scheduleAnchor) : null, frequency: row.repaymentFrequency })),
      },
    };
  }, { isolationLevel: 'RepeatableRead' });
}
