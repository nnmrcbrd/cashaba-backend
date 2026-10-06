import { businessDateLabel, FINANCIAL_TIMEZONE } from "@/utils/calendar";
import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { money } from "@/utils/money";
import { resolvePeriod } from "@/utils/period";
import { buildFinancialReview } from "@/utils/financialReview";
import { reportMonths, periodForecast } from '@/utils/reportingPeriod';

const expenseTypes = ["EXPENSE", "BILL_PAYMENT", "DEBT_PAYMENT"] as const;
const incomeTypes = ["INCOME"] as const;

export const getAnalytics = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const range = resolvePeriod({ period: String(req.query.period || "month"), startDate: req.query.startDate as string, endDate: req.query.endDate as string });
    const duration = range.end.getTime() - range.start.getTime();
    const previousStart = new Date(range.start.getTime() - duration - 1);
    const previousEnd = new Date(range.start.getTime() - 1);
    const months = reportMonths(range.start, range.end);
    const [transactions, previous, goals, budgets, setup] = await Promise.all([
      prisma.transaction.findMany({ where: { userId, deletedAt: null, date: { gte: range.start, lte: range.end } }, orderBy: { date: "asc" } }),
      prisma.transaction.findMany({ where: { userId, deletedAt: null, date: { gte: previousStart, lte: previousEnd } }, select: { type: true, amount: true } }),
      prisma.savingsGoal.findMany({ where: { userId } }),
      prisma.budget.findMany({ where: { userId, OR: months.map(({ month, year }) => ({ month, year })) } }),
      prisma.incomeSetup.findUnique({ where: { userId } }),
    ]);
    const totalIncome = transactions.filter((item) => incomeTypes.includes(item.type as typeof incomeTypes[number])).reduce((sum, item) => sum + money(item.amount), 0);
    const loanCollections = transactions.filter((item) => item.type === 'LOAN_COLLECTION').reduce((sum, item) => sum + money(item.amount), 0);
    const totalExpenses = transactions.filter((item) => expenseTypes.includes(item.type as typeof expenseTypes[number])).reduce((sum, item) => sum + money(item.amount), 0);
    const expenseCount = transactions.filter((item) => expenseTypes.includes(item.type as typeof expenseTypes[number])).length;
    const previousExpenses = previous.filter((item) => expenseTypes.includes(item.type as typeof expenseTypes[number])).reduce((sum, item) => sum + money(item.amount), 0);
    const categoryMap = transactions.filter((item) => expenseTypes.includes(item.type as typeof expenseTypes[number])).reduce<Record<string, number>>((totals, item) => {
      totals[item.category || "Others"] = (totals[item.category || "Others"] || 0) + money(item.amount);
      return totals;
    }, {});
    const categories = Object.entries(categoryMap).map(([name, amount]) => ({ name, amount, percentage: totalExpenses > 0 ? Math.round((amount / totalExpenses) * 100) : 0 })).sort((a, b) => b.amount - a.amount);
    const trendMap = transactions.reduce<Record<string, { income: number; expense: number }>>((points, item) => {
      const key = businessDateLabel(item.date);
      points[key] ||= { income: 0, expense: 0 };
      if (incomeTypes.includes(item.type as typeof incomeTypes[number])) points[key].income += money(item.amount);
      if (expenseTypes.includes(item.type as typeof expenseTypes[number])) points[key].expense += money(item.amount);
      return points;
    }, {});
    const saved = goals.reduce((sum, goal) => sum + money(goal.currentAmount), 0);
    const target = goals.reduce((sum, goal) => sum + money(goal.targetAmount), 0);
    const budgetTarget = Math.round(months.reduce((sum, period) => sum + money(budgets.find(budget => budget.month === period.month && budget.year === period.year)?.targetAmount) * period.fraction, 0) * 100) / 100;
    const budgetConfigured = budgets.length === months.length;
    const periodDays = Math.ceil((range.end.getTime() + 1 - range.start.getTime()) / 86_400_000);
    const configuredIncome = Math.round(money(setup?.totalIncome) * (setup?.incomePeriod === 'weekly' ? periodDays / 7 : months.reduce((sum, period) => sum + period.fraction, 0)) * 100) / 100;
    const baselineIncome = totalIncome;
    const projectedExpenses = periodForecast(totalExpenses, range.start, range.end);
    const projectedBalance = baselineIncome - projectedExpenses;
    const expenseChangePct = previousExpenses > 0 ? Math.round(((totalExpenses - previousExpenses) / previousExpenses) * 100) : null;
    const topCategory = categories[0] ?? null;
    const review = buildFinancialReview({
      totalIncome,
      configuredIncome,
      totalExpenses,
      netCashFlow: totalIncome - totalExpenses,
      projectedBalance,
      budgetConfigured,
      budgetTarget,
      budgetSpent: totalExpenses,
      savingsTarget: target,
      savingsSaved: saved,
      expenseChangePct,
      topCategory,
    });
    res.json({
      period: { key: range.period, start: range.start, end: range.end, timezone: FINANCIAL_TIMEZONE },
      summary: { totalIncome, loanCollections, configuredIncome, totalExpenses, netCashFlow: totalIncome - totalExpenses, transactionCount: transactions.length, expenseCount },
      categories,
      topCategory,
      trend: Object.entries(trendMap).map(([date, values]) => ({ date, ...values })),
      budget: { configured: budgetConfigured, target: budgetTarget, spent: totalExpenses, remaining: Math.max(0, budgetTarget - totalExpenses), percentage: budgetTarget > 0 ? Math.round((totalExpenses / budgetTarget) * 100) : 0, basis: 'Monthly budgets prorated to the selected days', missingMonths: months.length - budgets.length },
      savings: { saved, target, percentage: target > 0 ? Math.round((saved / target) * 100) : 0, goals: goals.length },
      comparison: { previousExpenses, expenseChangePct },
      forecast: { projectedExpenses, projectedBalance, plannedProjectedBalance: configuredIncome - projectedExpenses, incomeBasis: 'Recorded income only', method: 'Linear extrapolation of recorded spending; not a prediction of scheduled bills', sparseData: Date.now() - range.start.getTime() < 7 * 86_400_000 || expenseCount < 3 },
      review,
      transactions: transactions.map((item) => ({ ...item, amount: money(item.amount) })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_REPORTING_PERIOD') return res.status(400).json({ message: 'Choose valid calendar dates in chronological order' });
    console.error("Analytics error:", error);
    res.status(500).json({ message: "Error generating analytics" });
  }
};
