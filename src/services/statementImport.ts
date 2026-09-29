import { parseBankCSV } from '@/utils/gcashParser';
import { FinancialError, fingerprint, jsonValue, requireWallet, withFinancialOperation } from './financialOperation';
import { recordMovement } from './movements';

export async function importStatement(userId: string, walletId: string, buffer: Buffer, allowDuplicateRows = false, retryKey?: string) {
  if (buffer.byteLength > 2 * 1024 * 1024) throw new FinancialError('CSV file must be 2 MB or smaller', 413);
  const rows = await parseBankCSV(buffer);
  if (!rows.length) throw new FinancialError('No valid rows found in CSV', 422);
  if (rows.length > 1000) throw new FinancialError('Import at most 1,000 rows per file', 413);
  if (allowDuplicateRows && !retryKey) throw new FinancialError('A retry key is required to explicitly import matching rows');
  const payload = { walletId, rows, allowDuplicateRows };
  const batchKey = 'import-batch:' + (allowDuplicateRows ? retryKey : fingerprint(payload));
  return withFinancialOperation(userId, async tx => {
    await requireWallet(tx, userId, walletId);
    let imported = 0, skipped = 0;
    const occurrences = new Map<string, number>();
    for (const row of rows) {
      const canonical = { walletId, date: row.date, description: row.description, amount: row.amount };
      const rowHash = fingerprint(canonical);
      const occurrence = (occurrences.get(rowHash) ?? 0) + 1;
      occurrences.set(rowHash, occurrence);
      const key = 'import-row:' + rowHash + ':' + occurrence;
      const existing = await tx.financialOperation.findUnique({ where: { userId_key: { userId, key } } });
      if (existing && !allowDuplicateRows) { skipped++; continue; }
      const result = await recordMovement(tx, userId, { ...canonical, type: row.amount < 0 ? 'EXPENSE' : 'INCOME', amount: Math.abs(row.amount), category: row.amount < 0 ? 'Others' : 'Other Income' });
      if (!existing) await tx.financialOperation.create({ data: { userId, key, payloadHash: rowHash, result: jsonValue({ transactionId: result.id }) } });
      imported++;
    }
    return { imported, skipped, message: `Imported ${imported} rows; ${skipped} matched previously imported rows. Matching rows may be legitimate repeats; review them before explicitly importing duplicates.` };
  }, { key: batchKey, payload });
}
