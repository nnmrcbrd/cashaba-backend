import { Request, Response } from 'express';
import { z } from 'zod';
import { isFinancialDate } from '@/utils/calendar';
import { prisma } from '@/lib/prisma';
import { money } from '@/utils/money';
import { getSafeToSpend } from '@/utils/safeToSpend';
import { positiveMoney } from '@/schema/movement';
import { FinancialError, financialResponse, requestOperation, withFinancialOperation } from '@/services/financialOperation';
import { recordMovement, reverseMovement, updateMovement } from '@/services/movements';

export const createTransaction = async (req: Request, res: Response) => {
  try {
    const result = await withFinancialOperation(req.user!.userId, tx => recordMovement(tx, req.user!.userId, req.body), requestOperation(req));
    res.status(201).json({ ...result, safeToSpend: await getSafeToSpend(req.user!.userId) });
  } catch (error) { financialResponse(res, error, 'Error creating transaction'); }
};
export const getTransactions = async (req: Request, res: Response) => {
  try {
    const rows = await prisma.transaction.findMany({ where: { userId: req.user!.userId, deletedAt: null }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], include: { wallet: { select: { id: true, name: true, color: true } }, destinationWallet: { select: { id: true, name: true, color: true } } } });
    res.json(rows.map(row => ({ ...row, amount: money(row.amount) })));
  } catch (error) { financialResponse(res, error, 'Error fetching transactions'); }
};
const updates = z.object({ description: z.string().trim().min(1).max(200).optional(), category: z.string().trim().min(1).max(50).optional(), amount: positiveMoney.optional(), date: z.custom<string | Date>(isFinancialDate).pipe(z.coerce.date()).optional(), walletId: z.string().uuid().optional() }).refine(data => Object.keys(data).length > 0);
export const updateTransaction = async (req: Request, res: Response) => {
  try {
    const parsed = updates.safeParse(req.body);
    if (!parsed.success) throw new FinancialError('Invalid transaction update');
    const result = await withFinancialOperation(req.user!.userId, tx => updateMovement(tx, req.user!.userId, req.params.id as string, parsed.data), requestOperation(req));
    res.json({ ...result, safeToSpend: await getSafeToSpend(req.user!.userId) });
  } catch (error) { financialResponse(res, error, 'Error updating transaction'); }
};
export const softDeleteTransaction = (userId: string, id: string) => withFinancialOperation(userId, tx => reverseMovement(tx, userId, id));
export const deleteTransaction = async (req: Request, res: Response) => {
  try {
    await withFinancialOperation(req.user!.userId, tx => reverseMovement(tx, req.user!.userId, req.params.id as string), requestOperation(req));
    res.json({ message: 'Transaction moved to audit history', safeToSpend: await getSafeToSpend(req.user!.userId) });
  } catch (error) { financialResponse(res, error, 'Error deleting transaction'); }
};
export const undoLastTransaction = async (req: Request, res: Response) => {
  try {
    const result = await withFinancialOperation(req.user!.userId, async tx => {
      const latest = await tx.transaction.findFirst({ where: { userId: req.user!.userId, deletedAt: null, type: { notIn: ['LOAN_PROCEEDS', 'LOAN_DISBURSEMENT'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!latest) throw new FinancialError('No transaction is available to undo', 404);
      await reverseMovement(tx, req.user!.userId, latest.id);
      return { message: `Undid ${latest.description}`, transactionId: latest.id };
    }, requestOperation(req));
    res.json({ ...result, safeToSpend: await getSafeToSpend(req.user!.userId) });
  } catch (error) { financialResponse(res, error, 'Error undoing transaction'); }
};
