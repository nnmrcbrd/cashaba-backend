import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { money } from "@/utils/money";
import { calculateSafeToSpend } from '@/utils/safeToSpend';

/**
 * GET /api/user/health-score
 * Computes a 0-100 financial health score from existing DB data.
 * Read-only — does not mutate any data.
 *
 * Score breakdown:
 *  - Safe-to-Spend ratio (30 pts): safeToSpend / totalIncome
 *  - Savings progress (30 pts): currentAmount / targetAmount across goals
 *  - Spending control (25 pts): 100% if under budget, scaled down if over
 *  - Debt load (15 pts): 15 if no active loans, scaled by amount owed vs income
 */
export const getHealthScore = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [setup, savingsGoals, loans, budget, monthlyExpenses] = await Promise.all([
      calculateSafeToSpend(userId),
      prisma.savingsGoal.findMany({ where: { userId } }),
      prisma.loan.findMany({ where: { userId, type: 'BORROWED', status: { in: ["ACTIVE", "OVERDUE"] } } }),
      prisma.budget.findUnique({
        where: { userId_month_year: { userId, month: now.getMonth() + 1, year: now.getFullYear() } },
      }),
      prisma.transaction.aggregate({
        where: { userId, type: { in: ["EXPENSE", "BILL_PAYMENT", "DEBT_PAYMENT"] }, deletedAt: null, date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome = setup.totalIncome;
    const safeToSpend = setup.safeToSpend;

    // 1. Safe-to-Spend ratio (30 pts)
    let s2sScore = 0;
    if (totalIncome > 0) {
      const ratio = Math.min(safeToSpend / totalIncome, 1);
      s2sScore = Math.round(ratio * 30);
    }

    // 2. Savings progress (30 pts)
    let savingsScore = 0;
    if (savingsGoals.length > 0) {
      const avgProgress =
        savingsGoals.reduce((sum, g) => {
          const pct = money(g.targetAmount) > 0 ? Math.min(money(g.currentAmount) / money(g.targetAmount), 1) : 0;
          return sum + pct;
        }, 0) / savingsGoals.length;
      savingsScore = Math.round(avgProgress * 30);
    }

    // 3. Spending control (25 pts)
    let spendingScore = 0;
    if (budget && money(budget.targetAmount) > 0) {
      const spentRatio = money(monthlyExpenses._sum.amount) / money(budget.targetAmount);
      if (spentRatio >= 1) spendingScore = 0;
      else if (spentRatio >= 0.9) spendingScore = 10;
      else if (spentRatio >= 0.8) spendingScore = 18;
      else spendingScore = 25;
    }

    // 4. Debt load (15 pts)
    let debtScore = 15;
    if (loans.length > 0) {
      const totalDebt = loans.reduce((s, l) => s + Math.max(0, money(l.amount) - money(l.amountPaid)), 0);
      const debtRatio = totalIncome > 0 ? Math.min(totalDebt / totalIncome, 1) : totalDebt > 0 ? 1 : 0;
      debtScore = Math.round((1 - debtRatio) * 15);
    }

    const total = Math.min(s2sScore + savingsScore + spendingScore + debtScore, 100);

    // Letter grade
    let grade: string;
    let label: string;
    let color: string;
    if (total >= 85) {
      grade = "A";
      label = "Excellent";
      color = "#10b981";
    } else if (total >= 70) {
      grade = "B";
      label = "Good";
      color = "#3b82f6";
    } else if (total >= 50) {
      grade = "C";
      label = "Fair";
      color = "#f59e0b";
    } else {
      grade = "D";
      label = "Needs Work";
      color = "#ef4444";
    }

    res.json({
      score: total,
      grade,
      label,
      color,
      breakdown: {
        safeToSpend: s2sScore,
        savings: savingsScore,
        spending: spendingScore,
        debt: debtScore,
      },
    });
  } catch (error) {
    console.error("getHealthScore error:", error);
    res.status(500).json({ message: "Error computing health score" });
  }
};
