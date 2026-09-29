import { z } from 'zod';

export const positiveMoney = z.coerce.number().positive().finite().max(999_999_999_999.99)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.001, 'Use at most two decimal places');
export const movementSchema = z.object({
  description: z.string().trim().min(1).max(200),
  type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL', 'BILL_PAYMENT', 'DEBT_PAYMENT', 'LOAN_COLLECTION', 'LOAN_PROCEEDS', 'LOAN_DISBURSEMENT']),
  category: z.string().trim().min(1).max(50), amount: positiveMoney,
  date: z.coerce.date(), walletId: z.string().uuid(),
  destinationWalletId: z.string().uuid().nullable().optional(),
  savingsGoalId: z.string().uuid().nullable().optional(),
  fixedExpenseId: z.string().uuid().nullable().optional(),
  loanId: z.string().uuid().nullable().optional(),
}).superRefine((data, ctx) => {
  const links = {
    destinationWalletId: data.type === 'TRANSFER',
    savingsGoalId: ['SAVINGS_CONTRIBUTION', 'SAVINGS_WITHDRAWAL'].includes(data.type),
    fixedExpenseId: data.type === 'BILL_PAYMENT',
    loanId: ['DEBT_PAYMENT', 'LOAN_COLLECTION'].includes(data.type),
  };
  for (const [field, required] of Object.entries(links)) {
    if (Boolean(data[field as keyof typeof links]) !== required) ctx.addIssue({ code: 'custom', path: [field], message: required ? 'This movement requires a linked record' : 'This link is not allowed for this movement' });
  }
  if (data.destinationWalletId === data.walletId) ctx.addIssue({ code: 'custom', path: ['destinationWalletId'], message: 'Choose a different destination account' });
  if (data.type === 'ADJUSTMENT' && !['Balance Increase', 'Balance Decrease'].includes(data.category)) ctx.addIssue({ code: 'custom', path: ['category'], message: 'Choose an adjustment direction' });
});
export type MovementInput = z.input<typeof movementSchema>;
