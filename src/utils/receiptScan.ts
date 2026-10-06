import { z } from 'zod';
import { isCalendarDate } from './calendar';
import { positiveMoney } from '@/schema/movement';

export const receiptCategories = [
  'Food & Dining',
  'Transport',
  'Utilities',
  'Housing',
  'Health',
  'Entertainment',
  'Education',
  'Shopping',
  'Savings',
  'Debt Payment',
  'Others',
  'Salary',
  'Freelance',
  'Business',
  'Gift',
  'Other',
] as const;

const receiptScanSchema = z.object({
  amount: positiveMoney,
  description: z.string().trim().min(1).max(200),
  date: z.string().refine(isCalendarDate).nullable().default(null),
  category: z.enum(receiptCategories),
  transactionType: z.enum(['EXPENSE', 'INCOME']).nullable().default(null),
});

export type ReceiptScanResult = z.infer<typeof receiptScanSchema>;

export function parseReceiptModelResponse(responseText: string): ReceiptScanResult | null {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = receiptScanSchema.safeParse(JSON.parse(jsonMatch[0]));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
