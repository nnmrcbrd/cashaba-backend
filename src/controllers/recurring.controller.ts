import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { money } from "@/utils/money";

/**
 * GET /api/transactions/recurring
 * Scans transaction history for recurring patterns (same amount/description appearing 2+ times in 30 days).
 * Returns suggestions to add as Fixed Expenses.
 * Read-only — no mutations.
 */
export const detectRecurring = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        type: "EXPENSE",
        deletedAt: null,
        date: { gte: thirtyDaysAgo },
      },
      orderBy: { date: "desc" },
    });

    // Group by rounded amount + normalized description
    const patternMap: Record<string, { count: number; amount: number; description: string; category: string }> = {};

    transactions.forEach((t) => {
      // Normalize: round amount to nearest 50, lowercase description stem
      const numericAmount = money(t.amount);
      const key = `${Math.round(numericAmount / 50) * 50}-${t.description.toLowerCase().trim().slice(0, 20)}`;
      if (!patternMap[key]) {
        patternMap[key] = { count: 0, amount: numericAmount, description: t.description, category: t.category };
      }
      patternMap[key].count++;
    });

    // Only suggest patterns appearing 2+ times
    const suggestions = Object.values(patternMap)
      .filter((p) => p.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((p) => ({
        description: p.description,
        amount: p.amount,
        category: p.category,
        occurrences: p.count,
        suggestion: `"${p.description}" appears ${p.count}x — add as Fixed Expense?`,
      }));

    res.json({ suggestions });
  } catch (error) {
    console.error("detectRecurring error:", error);
    res.status(500).json({ message: "Error detecting recurring expenses" });
  }
};
