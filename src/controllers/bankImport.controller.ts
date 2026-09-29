import { Request, Response } from 'express';
import { z } from 'zod';
import { importStatement } from '@/services/statementImport';
import { financialResponse, requestOperation } from '@/services/financialOperation';
import { getSafeToSpend } from '@/utils/safeToSpend';
const schema = z.object({ csvBase64: z.string().min(1).max(3_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/), walletId: z.string().uuid(), allowDuplicateRows: z.boolean().default(false) });
export const importBankCSV = async (req: Request, res: Response) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid normalized CSV import request' });
  try {
    const result = await importStatement(req.user!.userId, parsed.data.walletId, Buffer.from(parsed.data.csvBase64, 'base64'), parsed.data.allowDuplicateRows, requestOperation(req)?.key);
    res.status(201).json({ ...result, safeToSpend: await getSafeToSpend(req.user!.userId) });
  } catch (error) { financialResponse(res, error, 'Error importing CSV'); }
};
