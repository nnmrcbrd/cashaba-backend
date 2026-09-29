import { Request, Response } from 'express';
import { importStatement } from '@/services/statementImport';
import { financialResponse } from '@/services/financialOperation';
import { getSafeToSpend } from '@/utils/safeToSpend';
export const importGCashTransactions = async (req: Request, res: Response) => {
  if (!req.file || typeof req.body?.walletId !== 'string') return res.status(400).json({ message: 'Select an account and a normalized CSV file' });
  try {
    const result = await importStatement(req.user!.userId, req.body.walletId, req.file.buffer);
    res.status(201).json({ ...result, count: result.imported, safeToSpend: await getSafeToSpend(req.user!.userId) });
  } catch (error) { financialResponse(res, error, 'Error importing CSV'); }
};
