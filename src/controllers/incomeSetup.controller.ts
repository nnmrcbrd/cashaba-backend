import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { calculateSafeToSpend, recalculateSafeToSpend } from "@/utils/safeToSpend";
import { z } from "zod";

const incomeSetupSchema = z.object({
  totalIncome: z.coerce.number().positive().finite(),
  incomePeriod: z.enum(["weekly", "monthly"]),
});

const fixedExpenseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: z.coerce.number().positive().finite(),
  dueDate: z.string().optional().refine(
    (value) => !value || !Number.isNaN(new Date(value).getTime()),
    "A valid due date is required",
  ),
});

const savingsGoalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  targetAmount: z.coerce.number().positive().finite(),
  monthlyAllocation: z.coerce.number().min(0).finite().default(0),
});

const savingsGoalUpdateSchema = z.object({
  addAmount: z.coerce.number().positive().finite().optional(),
  isCompleted: z.boolean().optional(),
  monthlyAllocation: z.coerce.number().min(0).finite().optional(),
}).refine((data) => Object.keys(data).length > 0, "At least one change is required");

// ─── Income Setup ────────────────────────────────────

/** GET /api/income-setup — returns income setup + safe-to-spend */
export const getIncomeSetup = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const setup = await prisma.incomeSetup.findUnique({ where: { userId } });

    if (!setup) {
      return res.json({ setup: null, safeToSpend: 0 });
    }

    // Recalculate on read and return the exact components used by the dashboard.
    const breakdown = await calculateSafeToSpend(userId);
    await prisma.incomeSetup.update({
      where: { userId },
      data: { safeToSpend: breakdown.safeToSpend },
    });
    return res.json({
      setup: { ...setup, safeToSpend: breakdown.safeToSpend },
      safeToSpend: breakdown.safeToSpend,
      breakdown,
    });
  } catch (error) {
    console.error("getIncomeSetup error:", error);
    res.status(500).json({ message: "Error fetching income setup" });
  }
};

/** POST /api/income-setup — create or update income setup (onboarding) */
export const upsertIncomeSetup = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const parsed = incomeSetupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid income setup", errors: parsed.error.flatten().fieldErrors });
    }
    const { totalIncome, incomePeriod } = parsed.data;

    const setup = await prisma.incomeSetup.upsert({
      where: { userId },
      create: {
        userId,
        totalIncome,
        incomePeriod,
        safeToSpend: totalIncome,
      },
      update: {
        totalIncome,
        incomePeriod,
      },
    });

    const safeToSpend = await recalculateSafeToSpend(userId);
    res.status(200).json({ setup: { ...setup, safeToSpend }, safeToSpend });
  } catch (error) {
    console.error("upsertIncomeSetup error:", error);
    res.status(500).json({ message: "Error saving income setup" });
  }
};

// ─── Fixed Expenses ──────────────────────────────────

/** GET /api/income-setup/fixed-expenses */
export const getFixedExpenses = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const expenses = await prisma.fixedExpense.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(expenses);
  } catch {
    res.status(500).json({ message: "Error fetching fixed expenses" });
  }
};

/** POST /api/income-setup/fixed-expenses */
export const addFixedExpense = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const parsed = fixedExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid fixed expense", errors: parsed.error.flatten().fieldErrors });
    }
    const { name, amount, dueDate } = parsed.data;

    const expense = await prisma.fixedExpense.create({
      data: {
        userId,
        name,
        amount,
        dueDate: dueDate ? new Date(dueDate) : null,
      },
    });

    const safeToSpend = await recalculateSafeToSpend(userId);
    res.status(201).json({ expense, safeToSpend });
  } catch {
    res.status(500).json({ message: "Error adding fixed expense" });
  }
};

/** DELETE /api/income-setup/fixed-expenses/:id */
export const deleteFixedExpense = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const id = req.params.id as string;

    const existing = await prisma.fixedExpense.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Fixed expense not found" });
    }

    await prisma.fixedExpense.delete({ where: { id } });
    const safeToSpend = await recalculateSafeToSpend(userId);
    res.json({ message: "Fixed expense deleted", safeToSpend });
  } catch {
    res.status(500).json({ message: "Error deleting fixed expense" });
  }
};

// ─── Savings Goals ───────────────────────────────────

/** GET /api/income-setup/savings-goals */
export const getSavingsGoals = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const goals = await prisma.savingsGoal.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    res.json(goals);
  } catch {
    res.status(500).json({ message: "Error fetching savings goals" });
  }
};

/** POST /api/income-setup/savings-goals */
export const addSavingsGoal = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const parsed = savingsGoalSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid savings goal", errors: parsed.error.flatten().fieldErrors });
    }
    const { name, targetAmount, monthlyAllocation } = parsed.data;

    const goal = await prisma.savingsGoal.create({
      data: {
        userId,
        name,
        targetAmount,
        monthlyAllocation,
      },
    });

    const safeToSpend = await recalculateSafeToSpend(userId);
    res.status(201).json({ goal, safeToSpend });
  } catch {
    res.status(500).json({ message: "Error adding savings goal" });
  }
};

/** PATCH /api/income-setup/savings-goals/:id — add funds or mark complete */
export const updateSavingsGoal = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const id = req.params.id as string;
    const parsed = savingsGoalUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid savings goal update", errors: parsed.error.flatten().fieldErrors });
    }
    const { addAmount, isCompleted, monthlyAllocation } = parsed.data;

    const existing = await prisma.savingsGoal.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Savings goal not found" });
    }

    const updateData: {
      currentAmount?: number;
      isCompleted?: boolean;
      monthlyAllocation?: number;
    } = {};

    // Add funds to current amount
    if (addAmount !== undefined) {
      const newAmount = existing.currentAmount + addAmount;
      updateData.currentAmount = newAmount;
      // Auto-complete if target reached
      if (newAmount >= existing.targetAmount) {
        updateData.isCompleted = true;
      }
    }

    if (typeof isCompleted === "boolean") {
      updateData.isCompleted = isCompleted;
    }

    if (monthlyAllocation !== undefined) {
      updateData.monthlyAllocation = monthlyAllocation;
    }

    const goal = await prisma.savingsGoal.update({
      where: { id },
      data: updateData,
    });

    const safeToSpend = await recalculateSafeToSpend(userId);
    res.json({ goal, safeToSpend });
  } catch {
    res.status(500).json({ message: "Error updating savings goal" });
  }
};

/** DELETE /api/income-setup/savings-goals/:id */
export const deleteSavingsGoal = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const id = req.params.id as string;

    const existing = await prisma.savingsGoal.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Savings goal not found" });
    }

    await prisma.savingsGoal.delete({ where: { id } });
    const safeToSpend = await recalculateSafeToSpend(userId);
    res.json({ message: "Savings goal deleted", safeToSpend });
  } catch {
    res.status(500).json({ message: "Error deleting savings goal" });
  }
};
