import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { calculateSafeToSpend, recalculateSafeToSpend } from "@/utils/safeToSpend";
import { money } from "@/utils/money";
import { z } from "zod";
import { FinancialError, financialResponse, requireWallet, requestOperation, withFinancialOperation } from '@/services/financialOperation';
import { recordMovement, requireNoActiveMovements } from '@/services/movements';
import { positiveMoney } from '@/schema/movement';

const incomeSetupSchema = z.object({ totalIncome: positiveMoney, incomePeriod: z.enum(["weekly", "monthly"]) });
const fixedExpenseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: positiveMoney,
  dueDate: z.string().optional().nullable().refine((value) => !value || !Number.isNaN(new Date(value).getTime()), "A valid due date is required"),
  frequency: z.enum(["ONE_TIME", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]).default("MONTHLY"),
  category: z.string().trim().min(1).max(50).default("Bills"),
  reminderDays: z.coerce.number().int().min(0).max(30).default(3),
  walletId: z.string().uuid().optional().nullable(),
});
const fixedExpenseUpdateSchema = fixedExpenseSchema.partial().refine((data) => Object.keys(data).length > 0, "At least one change is required");
const savingsGoalSchema = z.object({ name: z.string().trim().min(1).max(120), targetAmount: positiveMoney, monthlyAllocation: z.coerce.number().min(0).finite().default(0) });
const savingsGoalUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  targetAmount: positiveMoney.optional(),
  addAmount: positiveMoney.optional(),
  withdrawAmount: positiveMoney.optional(),
  walletId: z.string().uuid().optional().nullable(),
  isCompleted: z.boolean().optional(),
  monthlyAllocation: z.coerce.number().min(0).finite().optional(),
}).refine((data) => Object.keys(data).length > 0, "At least one change is required")
  .refine((data) => !(data.addAmount && data.withdrawAmount), "Choose either a contribution or withdrawal")
  .refine((data) => !(data.addAmount || data.withdrawAmount) || Boolean(data.walletId), { path: ["walletId"], message: "Select the source or destination account" });

function setupJson<T extends { totalIncome: unknown; safeToSpend: unknown }>(setup: T) {
  return { ...setup, totalIncome: money(setup.totalIncome), safeToSpend: money(setup.safeToSpend) };
}
function expenseJson<T extends { amount: unknown; amountPaid: unknown }>(expense: T) {
  return { ...expense, amount: money(expense.amount), amountPaid: money(expense.amountPaid), remaining: Math.max(0, money(expense.amount) - money(expense.amountPaid)) };
}
function goalJson<T extends { targetAmount: unknown; currentAmount: unknown; monthlyAllocation: unknown }>(goal: T) {
  return { ...goal, targetAmount: money(goal.targetAmount), currentAmount: money(goal.currentAmount), monthlyAllocation: money(goal.monthlyAllocation) };
}


export const getIncomeSetup = async (req: Request, res: Response) => {
  try {
    const setup = await prisma.incomeSetup.findUnique({ where: { userId: req.user!.userId } });
    if (!setup) return res.json({ setup: null, safeToSpend: 0 });
    const breakdown = await calculateSafeToSpend(req.user!.userId);
    res.json({ setup: setupJson({ ...setup, safeToSpend: breakdown.safeToSpend }), safeToSpend: breakdown.safeToSpend, breakdown });
  } catch (error) { financialResponse(res, error, 'Error fetching income setup'); }
};
export const upsertIncomeSetup = async (req: Request, res: Response) => {
  const parsed = incomeSetupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid income setup' });
  try {
    const userId = req.user!.userId;
    const setup = await withFinancialOperation(userId, async tx => {
      const saved = await tx.incomeSetup.upsert({ where: { userId }, create: { userId, ...parsed.data }, update: parsed.data });
      await tx.user.updateMany({ where: { id: userId, onboardingStep: { lt: 3 } }, data: { onboardingStep: 3 } });
      return saved;
    }, requestOperation(req));
    const safeToSpend = await recalculateSafeToSpend(userId);
    res.json({ setup: setupJson({ ...setup, safeToSpend }), safeToSpend });
  } catch (error) { financialResponse(res, error, 'Error saving income setup'); }
};
export const getFixedExpenses = async (req: Request, res: Response) => {
  try {
    const expenses = await prisma.fixedExpense.findMany({ where: { userId: req.user!.userId }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }], include: { wallet: { select: { id: true, name: true, color: true } } } });
    res.json(expenses.map(expense => expenseJson({ ...expense, status: !['COMPLETED', 'PAID'].includes(expense.status) && expense.dueDate && expense.dueDate < new Date() ? 'OVERDUE' : expense.status })));
  } catch (error) { financialResponse(res, error, 'Error fetching obligations'); }
};
export const addFixedExpense = async (req: Request, res: Response) => {
  const parsed = fixedExpenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid obligation' });
  try {
    const userId = req.user!.userId;
    const expense = await withFinancialOperation(userId, async tx => {
      if (parsed.data.walletId) await requireWallet(tx, userId, parsed.data.walletId);
      const dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : parsed.data.frequency !== 'ONE_TIME' ? new Date() : null;
      return tx.fixedExpense.create({ data: { ...parsed.data, dueDate, scheduleAnchor: dueDate, walletId: parsed.data.walletId || null, userId } });
    }, requestOperation(req));
    res.status(201).json({ expense: expenseJson(expense), safeToSpend: await recalculateSafeToSpend(userId) });
  } catch (error) { financialResponse(res, error, 'Error adding obligation'); }
};
export const updateFixedExpense = async (req: Request, res: Response) => {
  const parsed = fixedExpenseUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid obligation update' });
  try {
    const userId = req.user!.userId, id = req.params.id as string;
    const expense = await withFinancialOperation(userId, async tx => {
      const existing = await tx.fixedExpense.findFirst({ where: { id, userId } });
      if (!existing) throw new FinancialError('Obligation not found', 404);
      if (parsed.data.walletId) await requireWallet(tx, userId, parsed.data.walletId);
      if (parsed.data.amount !== undefined || parsed.data.frequency !== undefined || parsed.data.dueDate !== undefined) {
        // Historical schedule snapshots would otherwise be invalidated.
        if (await tx.transaction.count({ where: { fixedExpenseId: id, userId } })) throw new FinancialError('Create a new obligation to change a schedule with payment history.', 409);
      }
      const frequency = parsed.data.frequency ?? existing.frequency;
      const dueDate = parsed.data.dueDate === undefined ? existing.dueDate : parsed.data.dueDate ? new Date(parsed.data.dueDate) : null;
      const scheduled = dueDate ?? (frequency !== 'ONE_TIME' ? new Date() : null);
      return tx.fixedExpense.update({ where: { id }, data: { ...parsed.data, dueDate: scheduled, scheduleAnchor: parsed.data.dueDate !== undefined || parsed.data.frequency !== undefined ? scheduled : undefined } });
    }, requestOperation(req));
    res.json({ expense: expenseJson(expense), safeToSpend: await recalculateSafeToSpend(userId) });
  } catch (error) { financialResponse(res, error, 'Error updating obligation'); }
};
export const deleteFixedExpense = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId, id = req.params.id as string;
    await withFinancialOperation(userId, async tx => {
      if (!await tx.fixedExpense.findFirst({ where: { id, userId } })) throw new FinancialError('Obligation not found', 404);
      await requireNoActiveMovements(tx, userId, { fixedExpenseId: id });
      return tx.fixedExpense.delete({ where: { id } });
    }, requestOperation(req));
    res.json({ message: 'Obligation deleted', safeToSpend: await recalculateSafeToSpend(userId) });
  } catch (error) { financialResponse(res, error, 'Error deleting obligation'); }
};
export const getSavingsGoals = async (req: Request, res: Response) => {
  try { res.json((await prisma.savingsGoal.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: 'desc' } })).map(goalJson)); }
  catch (error) { financialResponse(res, error, 'Error fetching savings goals'); }
};
export const addSavingsGoal = async (req: Request, res: Response) => {
  const parsed = savingsGoalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid savings goal' });
  try {
    const userId = req.user!.userId;
    const goal = await withFinancialOperation(userId, tx => tx.savingsGoal.create({ data: { ...parsed.data, userId } }), requestOperation(req));
    res.status(201).json({ goal: goalJson(goal), safeToSpend: await recalculateSafeToSpend(userId) });
  } catch (error) { financialResponse(res, error, 'Error adding savings goal'); }
};
export const updateSavingsGoal = async (req: Request, res: Response) => {
  const parsed = savingsGoalUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid savings goal update' });
  try {
    const userId = req.user!.userId, id = req.params.id as string;
    const goal = await withFinancialOperation(userId, async tx => {
      const existing = await tx.savingsGoal.findFirst({ where: { id, userId } });
      if (!existing) throw new FinancialError('Savings goal not found', 404);
      const amount = parsed.data.addAmount ?? parsed.data.withdrawAmount;
      if (amount !== undefined) await recordMovement(tx, userId, { walletId: parsed.data.walletId, savingsGoalId: id, description: 'Savings: ' + existing.name, type: parsed.data.withdrawAmount !== undefined ? 'SAVINGS_WITHDRAWAL' : 'SAVINGS_CONTRIBUTION', category: 'Savings', amount, date: new Date() });
      const current = await tx.savingsGoal.findUniqueOrThrow({ where: { id } });
      if (parsed.data.isCompleted !== undefined && parsed.data.isCompleted !== (money(current.currentAmount) >= money(current.targetAmount))) throw new FinancialError('Completion is determined by the saved balance');
      const targetAmount = parsed.data.targetAmount ?? money(current.targetAmount);
      return tx.savingsGoal.update({
        where: { id },
        data: {
          name: parsed.data.name,
          targetAmount: parsed.data.targetAmount,
          monthlyAllocation: parsed.data.monthlyAllocation,
          isCompleted: money(current.currentAmount) >= targetAmount,
        },
      });
    }, requestOperation(req));
    res.json({ goal: goalJson(goal), safeToSpend: await recalculateSafeToSpend(userId) });
  } catch (error) { financialResponse(res, error, 'Error updating savings goal'); }
};
export const deleteSavingsGoal = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId, id = req.params.id as string;
    await withFinancialOperation(userId, async tx => {
      const goal = await tx.savingsGoal.findFirst({ where: { id, userId } });
      if (!goal) throw new FinancialError('Savings goal not found', 404);
      await requireNoActiveMovements(tx, userId, { savingsGoalId: id });
      if (money(goal.currentAmount) !== 0) throw new FinancialError('Withdraw or reconcile saved funds before deleting this goal', 409);
      return tx.savingsGoal.delete({ where: { id } });
    }, requestOperation(req));
    res.json({ message: 'Savings goal deleted', safeToSpend: await recalculateSafeToSpend(userId) });
  } catch (error) { financialResponse(res, error, 'Error deleting savings goal'); }
};
