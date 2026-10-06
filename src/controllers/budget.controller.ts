import { businessMonth, businessMidnight } from "@/utils/calendar";
import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { money } from "@/utils/money";
import { z } from "zod";

const categoriesSchema = z.array(z.object({ category: z.string().trim().min(1).max(50), limitAmount: z.coerce.number().min(0).finite() }))
  .max(30)
  .superRefine((categories, context) => {
    const seen = new Set<string>();
    categories.forEach((entry, index) => {
      const key = entry.category.toLocaleLowerCase('en-PH');
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index, 'category'], message: 'Budget category names must be unique' });
      seen.add(key);
    });
  });
const updateSchema = z.object({
  targetAmount: z.coerce.number().positive().finite(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2200).optional(),
  categories: categoriesSchema.optional(),
});

function selectedMonth(req: Request) {
  const now = businessMonth();
  const month = Number(req.query.month ?? req.body?.month ?? now.month);
  const year = Number(req.query.year ?? req.body?.year ?? now.year);
  return {
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : now.month,
    year: Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : now.year,
  };
}

export const getBudgets = async (req: Request, res: Response) => {
  try {
    const { month, year } = selectedMonth(req);
    const userId = req.user!.userId;
    const budget = await prisma.budget.findUnique({ where: { userId_month_year: { userId, month, year } }, include: { categories: true } });
    const start = businessMidnight(year, month - 1);
    const end = businessMidnight(year, month);
    const expenses = await prisma.transaction.findMany({
      where: { userId, deletedAt: null, type: { in: ["EXPENSE", "BILL_PAYMENT", "DEBT_PAYMENT"] }, date: { gte: start, lt: end } },
      select: { amount: true, category: true },
    });
    const amountSpent = expenses.reduce((sum, expense) => sum + money(expense.amount), 0);
    if (budget && money(budget.amountSpent) !== amountSpent) await prisma.budget.update({ where: { id: budget.id }, data: { amountSpent } });
    const categoryTotals = expenses.reduce<Record<string, number>>((totals, expense) => {
      totals[expense.category || "Others"] = (totals[expense.category || "Others"] || 0) + money(expense.amount);
      return totals;
    }, {});
    const limits = budget?.categories ?? [];
    const categoryNames = [...new Set([...limits.map((entry) => entry.category), ...Object.keys(categoryTotals)])];
    const categoryBreakdown = categoryNames.map((category) => {
      const allocated = money(limits.find((entry) => entry.category === category)?.limitAmount);
      const spent = categoryTotals[category] || 0;
      const percentage = allocated > 0 ? Math.round((spent / allocated) * 100) : 0;
      return { category, allocated, spent, remaining: Math.max(0, allocated - spent), percentage: Math.min(100, percentage), status: allocated <= 0 ? "UNSET" : percentage >= 100 ? "EXCEEDED_100" : percentage >= 80 ? "WARNING_80" : "NORMAL" };
    }).sort((a, b) => b.spent - a.spent);
    const targetAmount = money(budget?.targetAmount);
    const spentPct = targetAmount > 0 ? Math.round((amountSpent / targetAmount) * 100) : 0;
    res.json({
      month, year, configured: Boolean(budget), targetAmount, amountSpent,
      remaining: Math.max(0, targetAmount - amountSpent), spentPct: Math.min(100, spentPct),
      overallStatus: !budget ? "NOT_CONFIGURED" : spentPct >= 100 ? "EXCEEDED_100" : spentPct >= 80 ? "WARNING_80" : "NORMAL",
      categoryBreakdown,
    });
  } catch (error) {
    console.error("Get budget error:", error);
    res.status(500).json({ message: "Error fetching budget details" });
  }
};

export const updateBudget = async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Valid budget details required", errors: parsed.error.flatten().fieldErrors });
  try {
    const now = businessMonth();
    const month = parsed.data.month ?? now.month;
    const year = parsed.data.year ?? now.year;
    const userId = req.user!.userId;
    const updated = await prisma.budget.upsert({
      where: { userId_month_year: { userId, month, year } },
      create: { userId, month, year, targetAmount: parsed.data.targetAmount, amountSpent: 0, categories: parsed.data.categories ? { create: parsed.data.categories } : undefined },
      update: { targetAmount: parsed.data.targetAmount, categories: parsed.data.categories ? { deleteMany: {}, create: parsed.data.categories } : undefined },
      include: { categories: true },
    });
    await prisma.user.updateMany({ where: { id: userId, onboardingStep: { lt: 4 } }, data: { onboardingStep: 4 } });
    res.json({ ...updated, targetAmount: money(updated.targetAmount), amountSpent: money(updated.amountSpent), categories: updated.categories.map((entry) => ({ ...entry, limitAmount: money(entry.limitAmount) })) });
  } catch (error) {
    console.error("Update budget error:", error);
    res.status(500).json({ message: "Error updating budget" });
  }
};

export const copyPreviousBudget = async (req: Request, res: Response) => {
  try {
    const { month, year } = selectedMonth(req);
    const current = new Date(Date.UTC(year, month - 2, 1));
    const userId = req.user!.userId;
    const previous = await prisma.budget.findUnique({ where: { userId_month_year: { userId, month: current.getUTCMonth() + 1, year: current.getUTCFullYear() } }, include: { categories: true } });
    if (!previous) return res.status(404).json({ message: "No previous-month budget was found" });
    const copied = await prisma.budget.upsert({
      where: { userId_month_year: { userId, month, year } },
      create: { userId, month, year, targetAmount: previous.targetAmount, amountSpent: 0, categories: { create: previous.categories.map((entry) => ({ category: entry.category, limitAmount: entry.limitAmount })) } },
      update: { targetAmount: previous.targetAmount, categories: { deleteMany: {}, create: previous.categories.map((entry) => ({ category: entry.category, limitAmount: entry.limitAmount })) } },
      include: { categories: true },
    });
    res.json({ ...copied, targetAmount: money(copied.targetAmount), amountSpent: money(copied.amountSpent), categories: copied.categories.map((entry) => ({ ...entry, limitAmount: money(entry.limitAmount) })) });
  } catch (error) {
    console.error("Copy budget error:", error);
    res.status(500).json({ message: "Error copying previous budget" });
  }
};
