import { Readable } from 'stream';
import csv from 'csv-parser';
import { FinancialError } from '@/services/financialOperation';
import { isCalendarDate } from './calendar';
export interface GCashRow { amount: number; description: string; date: string }
// Supported contract: Date (YYYY-MM-DD), Description, signed Amount; or Debit/Credit.
// Bank labels do not imply support for proprietary export formats.
export function parseBankCSV(buffer: Buffer): Promise<GCashRow[]> {
  return new Promise((resolve, reject) => {
    const rows: GCashRow[] = [];
    let invalid: string | null = null, line = 1;
    Readable.from(buffer).pipe(csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, '').trim().toLowerCase() }))
      .on('data', (row: Record<string, string>) => {
        line++;
        const description = (row.description ?? row.details ?? '').trim();
        const date = (row.date ?? row['transaction date'] ?? '').trim();
        const numeric = (value: string) => Number(value.replace(/[₱,\s]/g, ''));
        let amount = numeric(row.amount ?? row['transaction amount'] ?? row.transaction_amount ?? '0');
        if ('debit' in row || 'credit' in row) {
          const debit = numeric(row.debit || '0'), credit = numeric(row.credit || '0');
          if (debit < 0 || credit < 0 || (debit > 0 && credit > 0)) invalid ||= 'A row cannot have both a debit and credit';
          amount = credit - debit;
        }
        const parsed = new Date(date + 'T00:00:00Z');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || !description || description.length > 200 || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 999999999999.99 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.001) invalid ||= 'Invalid row ' + line + '. Use Date (YYYY-MM-DD), Description, and signed Amount (or Debit/Credit), with at most two decimal places.';
        rows.push({ amount, description, date });
      })
      .on('end', () => invalid ? reject(new FinancialError(invalid, 422)) : resolve(rows))
      .on('error', reject);
  });
}
export const parseGCashCSV = parseBankCSV;

/**
 * parseGCashImageText
 * Parses OCR-extracted text from a GCash screenshot to extract amount, description, and date.
 * Called after Gemini Vision API extracts the text content from the image.
 */
export function parseGCashImageText(ocrText: string): { amount: number; description: string; date: string | null; transactionType: 'INCOME' | 'EXPENSE' | null } | null {
    try {
        // Extract amount — match "₱1,234.56" or "PHP 1,234.56" or plain "1234.56"
        const amountMatch = ocrText.match(/(?:₱|PHP\s*)([\d,]+(?:\.\d{1,2})?)/i);
        if (!amountMatch) return null;
        const amount = parseFloat(amountMatch[1].replace(/,/g, ""));
        if (!Number.isFinite(amount) || amount <= 0) return null;

        // Extract description — look for "to", "from", "at", merchant name patterns
        const descriptionMatch =
            ocrText.match(/(?:sent to|paid to|received from|at|merchant:?)\s*([A-Za-z0-9\s&.'-]{2,40})/i) ||
            ocrText.match(/([A-Z][A-Za-z0-9\s&.'-]{2,30})\s*(?:₱|PHP)/i);
        const description = descriptionMatch
            ? descriptionMatch[1].trim()
            : "GCash Transaction";

        // Extract date — match common date formats
        const dateMatch = ocrText.match(
            /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\w+ \d{1,2},?\s*\d{4}|\d{4}-\d{2}-\d{2})/i
        );
        // Prefer the explicit date-only contract. Ambiguous numeric dates and
        // missing dates remain unknown, for the user to select during review.
        const exactDate = ocrText.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
        let date: string | null = exactDate && isCalendarDate(exactDate) ? exactDate : null;
        if (!exactDate && dateMatch && /^[A-Za-z]+\s/.test(dateMatch[1])) {
            const named = dateMatch[1].match(/^([A-Za-z]+) (\d{1,2}),?\s*(\d{4})$/);
            const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
            const month = named ? months.findIndex(value => value === named[1].toLowerCase() || value.slice(0, 3) === named[1].toLowerCase()) : -1;
            const candidate = named && month >= 0 ? `${named[3]}-${String(month + 1).padStart(2, '0')}-${named[2].padStart(2, '0')}` : null;
            if (candidate && isCalendarDate(candidate)) date = candidate;
        }
        const incoming = /\breceived from\b|\bmoney received\b|\bsalary credited\b/i.test(ocrText);
        const outgoing = /\bsent to\b|\bpaid to\b|\bpayment sent\b/i.test(ocrText);
        const transactionType = incoming === outgoing ? null : incoming ? 'INCOME' as const : 'EXPENSE' as const;
        return { amount, description, date, transactionType };
    } catch {
        return null;
    }
}
