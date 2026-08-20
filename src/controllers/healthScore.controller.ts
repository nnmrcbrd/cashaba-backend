import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";

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

    const [setup, savingsGoals, loans, budget] = await Promise.all([
      prisma.incomeSetup.findUnique({ where: { userId } }),
      prisma.savingsGoal.findMany({ where: { userId, isCompleted: false } }),
      prisma.loan.findMany({ where: { userId, status: "ACTIVE" } }),
      prisma.budget.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const totalIncome = setup?.totalIncome || 0;
    const safeToSpend = setup?.safeToSpend || 0;

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
          const pct = g.targetAmount > 0 ? Math.min(g.currentAmount / g.targetAmount, 1) : 0;
          return sum + pct;
        }, 0) / savingsGoals.length;
      savingsScore = Math.round(avgProgress * 30);
    } else {
      // No goals set yet — neutral score (15)
      savingsScore = 15;
    }

    // 3. Spending control (25 pts)
    let spendingScore = 25;
    if (budget && budget.targetAmount > 0) {
      const spentRatio = budget.amountSpent / budget.targetAmount;
      if (spentRatio >= 1) spendingScore = 0;
      else if (spentRatio >= 0.9) spendingScore = 10;
      else if (spentRatio >= 0.8) spendingScore = 18;
      else spendingScore = 25;
    }

    // 4. Debt load (15 pts)
    let debtScore = 15;
    if (loans.length > 0 && totalIncome > 0) {
      const totalDebt = loans.reduce((s, l) => s + l.amount, 0);
      const debtRatio = Math.min(totalDebt / totalIncome, 1);
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
