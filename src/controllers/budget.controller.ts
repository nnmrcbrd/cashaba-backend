import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";

export const getBudgets = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // 1. Fetch or create overall monthly budget
    let budget = await prisma.budget.findFirst({
      where: {
        userId,
        month: currentMonth,
        year: currentYear,
      },
    });

    const startOfMonth = new Date(currentYear, currentMonth - 1, 1);
    const endOfMonth = new Date(currentYear, currentMonth, 0, 23, 59, 59);

    // 2. Fetch all expenses this month
    const expenses = await prisma.transaction.findMany({
      where: {
        userId,
        type: "EXPENSE",
        createdAt: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
    });

    const totalSpent = expenses.reduce((sum, e) => sum + e.amount, 0);

    if (!budget) {
      budget = await prisma.budget.create({
        data: {
          userId,
          month: currentMonth,
          year: currentYear,
          targetAmount: 20000,
          amountSpent: totalSpent,
        },
      });
    } else {
      budget = await prisma.budget.update({
        where: { id: budget.id },
        data: { amountSpent: totalSpent },
      });
    }

    // 3. Compute category breakdown
    const categoryTotals: Record<string, number> = {};
    expenses.forEach((e) => {
      const cat = e.category || "Others";
      categoryTotals[cat] = (categoryTotals[cat] || 0) + e.amount;
    });

    // Preset standard categories with allocations based on budget ratio
    const standardCategories = [
      { name: "Food & Dining", weight: 0.35, icon: "🍱" },
      { name: "Transport", weight: 0.15, icon: "🚗" },
      { name: "Utilities", weight: 0.20, icon: "⚡" },
      { name: "Housing", weight: 0.10, icon: "🏠" },
      { name: "Shopping", weight: 0.10, icon: "🛍️" },
      { name: "Others", weight: 0.10, icon: "📦" },
    ];

    const categoryBreakdown = standardCategories.map((c) => {
      const catSpent = categoryTotals[c.name] || 0;
      const catLimit = Math.round(budget!.targetAmount * c.weight);
      const catPct = Math.min(100, Math.round((catSpent / (catLimit || 1)) * 100));
      return {
        category: c.name,
        icon: c.icon,
        allocated: catLimit,
        spent: catSpent,
        remaining: Math.max(0, catLimit - catSpent),
        percentage: catPct,
        status: catPct >= 100 ? "EXCEEDED_100" : catPct >= 80 ? "WARNING_80" : "NORMAL",
      };
    });

    // 4. Overall alert status
    const spentPct = Math.min(100, Math.round((totalSpent / (budget.targetAmount || 1)) * 100));
    const overallStatus = spentPct >= 100 ? "EXCEEDED_100" : spentPct >= 80 ? "WARNING_80" : "NORMAL";

    res.json({
      month: currentMonth,
      year: currentYear,
      targetAmount: budget.targetAmount,
      amountSpent: totalSpent,
      remaining: Math.max(0, budget.targetAmount - totalSpent),
      spentPct,
      overallStatus,
      categoryBreakdown,
    });
  } catch (error) {
    console.error("Get budget error:", error);
    res.status(500).json({ message: "Error fetching budget details" });
  }
};

export const updateBudget = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const { targetAmount } = req.body;
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    if (!targetAmount || Number(targetAmount) <= 0) {
      return res.status(400).json({ message: "Valid targetAmount required" });
    }

    const existing = await prisma.budget.findFirst({
      where: { userId, month: currentMonth, year: currentYear },
    });

    let updated;
    if (existing) {
      updated = await prisma.budget.update({
        where: { id: existing.id },
        data: { targetAmount: Number(targetAmount) },
      });
    } else {
      updated = await prisma.budget.create({
        data: {
          userId,
          month: currentMonth,
          year: currentYear,
          targetAmount: Number(targetAmount),
          amountSpent: 0,
        },
      });
    }

    res.json(updated);
  } catch (error) {
    console.error("Update budget error:", error);
    res.status(500).json({ message: "Error updating budget" });
  }
};
