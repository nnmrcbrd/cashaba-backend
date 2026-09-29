import { money } from '@/utils/money';
import { getSafeToSpend } from '@/utils/safeToSpend';
import { occurrenceDate } from '@/utils/recurrence';
import { FinancialError, type FinancialTx, withFinancialOperation } from './financialOperation';
import { recordMovement } from './movements';
export { FinancialError as LoanRepaymentError } from './financialOperation';

export function calculateRepaymentProgress(input: { deadline: Date; frequency: string; repaymentAmount: number; installmentPaid: number; payment: number; isPaidOff: boolean }) {
  const total = Math.round((input.installmentPaid + input.payment) * 100);
  const installment = Math.round(input.repaymentAmount * 100);
  const count = !input.isPaidOff && input.frequency !== 'ONE_TIME' && installment > 0 ? Math.floor(total / installment) : 0;
  return { installmentPaid: input.isPaidOff ? 0 : (total - count * installment) / 100, deadline: occurrenceDate(input.deadline, input.frequency, count) };
}
export interface LoanPaymentInput { userId: string; loanId: string; amount: number; paidAt: Date; walletId?: string | null }
export async function recordLoanPaymentInTransaction(tx: FinancialTx, input: LoanPaymentInput) {
  const loan = await tx.loan.findFirst({ where: { id: input.loanId, userId: input.userId } });
  if (!loan) throw new FinancialError('Loan not found', 404);
  const transaction = await recordMovement(tx, input.userId, {
    loanId: loan.id, walletId: input.walletId, amount: input.amount, date: input.paidAt,
    description: `${loan.type === 'BORROWED' ? 'Loan payment' : 'Loan collection'}: ${loan.title}`,
    type: loan.type === 'BORROWED' ? 'DEBT_PAYMENT' : 'LOAN_COLLECTION', category: loan.type === 'BORROWED' ? 'Debt Repayment' : 'Loan Collection',
  });
  const updated = await tx.loan.findUniqueOrThrow({ where: { id: loan.id } });
  return { transaction, loan: { ...updated, amount: money(updated.amount), amountPaid: money(updated.amountPaid), installmentPaid: money(updated.installmentPaid), repaymentAmount: money(updated.repaymentAmount) }, remaining: money(updated.amount) - money(updated.amountPaid) };
}
export async function recordLoanPayment(input: LoanPaymentInput, operation?: { key: string; payload: unknown }) {
  const result = await withFinancialOperation(input.userId, tx => recordLoanPaymentInTransaction(tx, input), operation);
  return { ...result, safeToSpend: await getSafeToSpend(input.userId) };
}
