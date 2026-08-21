import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";

// ─── Income Setup ────────────────────────────────────

/** GET /api/income-setup — returns income setup + safe-to-spend */
export const getIncomeSetup = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const setup = await prisma.incomeSetup.findUnique({ where: { userId } });

    if (!setup) {
      return res.json({ setup: null, safeToSpend: 0 });
    }

    // Recalculate on read to ensure freshness
    const safeToSpend = await recalculateSafeToSpend(userId);
    return res.json({ setup: { ...setup, safeToSpend }, safeToSpend });
  } catch (error) {
    console.error("getIncomeSetup error:", error);
    res.status(500).json({ message: "Error fetching income setup" });
  }
};

/** POST /api/income-setup — create or update income setup (onboarding) */
export const upsertIncomeSetup = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId || req.user!.id;
    const { totalIncome, incomePeriod } = req.body;

    if (!totalIncome || !incomePeriod) {
      return res.status(400).json({ message: "totalIncome and incomePeriod required" });
    }

    const setup = await prisma.incomeSetup.upsert({
      where: { userId },
      create: {
        userId,
        totalIncome: parseFloat(totalIncome),
        incomePeriod,
        safeToSpend: parseFloat(totalIncome),
      },
      update: {
        totalIncome: parseFloat(totalIncome),
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
    const { name, amount, dueDate } = req.body;

    if (!name || !amount) {
      return res.status(400).json({ message: "name and amount required" });
    }

    const expense = await prisma.fixedExpense.create({
      data: {
        userId,
        name,
        amount: parseFloat(amount),
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
    const { name, targetAmount, monthlyAllocation } = req.body;

    if (!name || !targetAmount) {
      return res.status(400).json({ message: "name and targetAmount required" });
    }

    const goal = await prisma.savingsGoal.create({
      data: {
        userId,
        name,
        targetAmount: parseFloat(targetAmount),
        monthlyAllocation: parseFloat(monthlyAllocation || "0"),
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
    const { addAmount, isCompleted, monthlyAllocation } = req.body;

    const existing = await prisma.savingsGoal.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Savings goal not found" });
    }

    const updateData: any = {};

    // Add funds to current amount
    if (addAmount) {
      const newAmount = existing.currentAmount + parseFloat(addAmount);
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
      updateData.monthlyAllocation = parseFloat(monthlyAllocation);
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
