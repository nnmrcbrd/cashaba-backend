import type { FixedExpense, Prisma, Transaction } from '@/generated/prisma/client';
import { movementSchema, positiveMoney } from '@/schema/movement';
import { FinancialError, type FinancialTx, jsonValue, requireWallet } from './financialOperation';
import { money, roundMoney } from '@/utils/money';
import { occurrenceDate } from '@/utils/recurrence';
import { billAmountSchedule, billProgress, replaceBillAmount } from '@/utils/billAmounts';

type Related = Record<string, string | boolean | null>;
const includeWallets = {
  wallet: { select: { id: true, name: true, color: true } },
  destinationWallet: { select: { id: true, name: true, color: true } },
} as const;

async function history(tx: FinancialTx, userId: string, link: Prisma.TransactionWhereInput) {
  const rows = await tx.transaction.findMany({ where: { userId, ...link }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { audits: { where: { action: 'CREATED' }, orderBy: { createdAt: 'asc' }, take: 1 } } });
  const snapshot = rows[0]?.audits[0]?.snapshot as { relatedBefore?: Related } | undefined;
  if (!snapshot?.relatedBefore) throw new FinancialError('This legacy payment has no original schedule snapshot. Reconcile its history before changing it.', 409);
  return { baseline: snapshot.relatedBefore, paid: roundMoney(rows.filter(row => !row.deletedAt).reduce((sum, row) => sum + money(row.amount), 0)) };
}

async function rebuildBill(tx: FinancialTx, userId: string, id: string) {
  const bill = await tx.fixedExpense.findFirst({ where: { id, userId } });
  if (!bill) return;
  const { baseline, paid } = await history(tx, userId, { fixedExpenseId: id });
  const amount = money(bill.amount);
  const total = roundMoney(Number(baseline.amountPaid || 0) + paid);
  const anchor = baseline.dueDate ? new Date(String(baseline.dueDate)) : bill.scheduleAnchor ?? bill.createdAt;
  const recurring = bill.frequency !== 'ONE_TIME';
  const progress = billProgress(total, billAmountSchedule(bill.amountSchedule, amount));
  const installments = recurring ? progress.installments : 0;
  const amountPaid = recurring ? progress.amountPaid : total;
  const dueDate = recurring ? occurrenceDate(anchor, bill.frequency, installments) : baseline.dueDate ? anchor : null;
  if (!recurring && total > amount) throw new FinancialError('Payment exceeds the obligation');
  const completed = !recurring && amountPaid >= amount;
  return tx.fixedExpense.update({ where: { id }, data: { amount: recurring ? progress.amount : amount, amountPaid, dueDate, scheduleAnchor: anchor, status: completed ? 'COMPLETED' : dueDate && dueDate < new Date() ? 'OVERDUE' : amountPaid > 0 ? 'PARTIALLY_PAID' : 'PENDING' } });
}

// The onboarding amount is an estimate. A correction applies to the current
// and future installments, while completed installments retain their prices.
export async function updateBillAmount(tx: FinancialTx, userId: string, bill: FixedExpense, amount: number) {
  if (amount < money(bill.amountPaid)) throw new FinancialError('The bill amount cannot be less than the amount already paid.');
  const hasHistory = await tx.transaction.count({ where: { userId, fixedExpenseId: bill.id } });
  let installment = 0;
  if (hasHistory && bill.frequency !== 'ONE_TIME') {
    const { baseline, paid } = await history(tx, userId, { fixedExpenseId: bill.id });
    installment = billProgress(roundMoney(Number(baseline.amountPaid || 0) + paid), billAmountSchedule(bill.amountSchedule, money(bill.amount))).installments;
  }
  const amountSchedule = replaceBillAmount(billAmountSchedule(bill.amountSchedule, money(bill.amount)), installment, amount);
  const updated = await tx.fixedExpense.update({ where: { id: bill.id }, data: { amount, amountSchedule } });
  if (hasHistory) return (await rebuildBill(tx, userId, bill.id))!;
  return tx.fixedExpense.update({ where: { id: bill.id }, data: {
    status: bill.frequency === 'ONE_TIME' && money(updated.amountPaid) >= amount ? 'COMPLETED'
      : bill.dueDate && bill.dueDate < new Date() ? 'OVERDUE' : money(updated.amountPaid) > 0 ? 'PARTIALLY_PAID' : 'PENDING',
  } });
}

async function rebuildLoan(tx: FinancialTx, userId: string, id: string) {
  const loan = await tx.loan.findFirst({ where: { id, userId } });
  if (!loan) return;
  const { baseline, paid } = await history(tx, userId, { loanId: id, type: { in: ['DEBT_PAYMENT', 'LOAN_COLLECTION'] } });
  const total = roundMoney(Number(baseline.amountPaid || 0) + paid);
  if (total > money(loan.amount)) throw new FinancialError('Payment exceeds the loan balance');
  const anchor = new Date(String(baseline.deadline));
  const installmentTotal = roundMoney(Number(baseline.installmentPaid || 0) + paid);
  const recurring = loan.repaymentFrequency !== 'ONE_TIME' && money(loan.repaymentAmount) > 0;
  const installments = recurring ? Math.floor(Math.round(installmentTotal * 100) / Math.round(money(loan.repaymentAmount) * 100)) : 0;
  const deadline = occurrenceDate(anchor, loan.repaymentFrequency, installments);
  const complete = total >= money(loan.amount);
  await tx.loan.update({ where: { id }, data: { amountPaid: total, installmentPaid: complete ? 0 : roundMoney(installmentTotal - installments * money(loan.repaymentAmount)), deadline, scheduleAnchor: anchor, status: complete ? 'PAID_OFF' : deadline < new Date() ? 'OVERDUE' : 'ACTIVE' } });
}

// Must run inside withFinancialOperation, after the user lock is acquired.
export async function recordMovement(tx: FinancialTx, userId: string, input: unknown) {
  const parsed = movementSchema.safeParse(input);
  if (!parsed.success) throw new FinancialError(parsed.error.issues.map(issue => issue.message).join('; '));
  const data = parsed.data;
  if (['LOAN_PROCEEDS', 'LOAN_DISBURSEMENT'].includes(data.type)) throw new FinancialError('Loan principal movements are created with the loan', 409);
  await requireWallet(tx, userId, data.walletId);
  if (data.destinationWalletId) await requireWallet(tx, userId, data.destinationWalletId);
  let relatedBefore: Related | undefined;
  if (data.savingsGoalId) {
    const goal = await tx.savingsGoal.findFirst({ where: { id: data.savingsGoalId, userId } });
    if (!goal) throw new FinancialError('Savings goal not found', 404);
    const next = roundMoney(money(goal.currentAmount) + (data.type === 'SAVINGS_WITHDRAWAL' ? -data.amount : data.amount));
    if (next < 0) throw new FinancialError('Withdrawal exceeds saved funds');
    relatedBefore = { kind: 'SavingsGoal', id: goal.id, currentAmount: String(goal.currentAmount), isCompleted: goal.isCompleted };
    await tx.savingsGoal.update({ where: { id: goal.id }, data: { currentAmount: next, isCompleted: next >= money(goal.targetAmount) } });
  }
  if (data.fixedExpenseId) {
    let bill = await tx.fixedExpense.findFirst({ where: { id: data.fixedExpenseId, userId } });
    if (!bill) throw new FinancialError('Obligation not found', 404);
    const amountBefore = String(bill.amount);
    if (data.amount > roundMoney(money(bill.amount) - money(bill.amountPaid))) {
      // Reconcile the selected bill's onboarding estimate and payment in the
      // same locked transaction. Smaller payments remain partial payments.
      const actualAmount = positiveMoney.safeParse(roundMoney(money(bill.amountPaid) + data.amount));
      if (!actualAmount.success) throw new FinancialError('The resulting bill amount exceeds the supported limit.');
      bill = await updateBillAmount(tx, userId, bill, actualAmount.data);
    }
    relatedBefore = { kind: 'FixedExpense', id: bill.id, amountBefore, amount: String(bill.amount), amountPaid: String(bill.amountPaid), status: bill.status, dueDate: bill.dueDate?.toISOString() ?? null };
  }
  if (data.loanId) {
    const loan = await tx.loan.findFirst({ where: { id: data.loanId, userId } });
    if (!loan) throw new FinancialError('Loan not found', 404);
    if ((loan.type === 'BORROWED' ? 'DEBT_PAYMENT' : 'LOAN_COLLECTION') !== data.type) throw new FinancialError('Payment direction does not match the loan');
    if (loan.status === 'PAID_OFF' || data.amount > roundMoney(money(loan.amount) - money(loan.amountPaid))) throw new FinancialError('Payment exceeds the remaining loan balance');
    relatedBefore = { kind: 'Loan', id: loan.id, amountPaid: String(loan.amountPaid), installmentPaid: String(loan.installmentPaid), status: loan.status, deadline: loan.deadline.toISOString() };
  }
  const movement = await tx.transaction.create({ data: { ...data, userId }, include: includeWallets });
  await tx.transactionAudit.create({ data: { userId, transactionId: movement.id, action: 'CREATED', snapshot: jsonValue({ transaction: movement, relatedBefore: relatedBefore ?? null }) } });
  if (data.fixedExpenseId) await rebuildBill(tx, userId, data.fixedExpenseId);
  if (data.loanId) await rebuildLoan(tx, userId, data.loanId);
  return { ...movement, amount: money(movement.amount) };
}

export async function reverseMovement(tx: FinancialTx, userId: string, id: string) {
  const movement = await tx.transaction.findFirst({ where: { id, userId } });
  if (!movement) throw new FinancialError('Transaction not found', 404);
  if (['LOAN_PROCEEDS', 'LOAN_DISBURSEMENT'].includes(movement.type)) throw new FinancialError('Delete the loan to reverse its principal movement', 409);
  if (movement.deletedAt) return { ...movement, amount: money(movement.amount) };
  if (movement.savingsGoalId) {
    const goal = await tx.savingsGoal.findFirst({ where: { id: movement.savingsGoalId, userId } });
    if (goal) {
      const delta = movement.type === 'SAVINGS_WITHDRAWAL' ? money(movement.amount) : -money(movement.amount);
      const next = roundMoney(money(goal.currentAmount) + delta);
      if (next < 0) throw new FinancialError('Later withdrawals use these savings. Reverse those withdrawals first.', 409);
      await tx.savingsGoal.update({ where: { id: goal.id }, data: { currentAmount: next, isCompleted: next >= money(goal.targetAmount) } });
    }
  }
  const deleted = await tx.transaction.update({ where: { id }, data: { deletedAt: new Date() } });
  if (movement.fixedExpenseId) await rebuildBill(tx, userId, movement.fixedExpenseId);
  if (movement.loanId) await rebuildLoan(tx, userId, movement.loanId);
  await tx.transactionAudit.create({ data: { userId, transactionId: id, action: 'DELETED', snapshot: jsonValue({ transaction: movement }) } });
  return { ...deleted, amount: money(deleted.amount) };
}

export async function updateMovement(tx: FinancialTx, userId: string, id: string, updates: Partial<Pick<Transaction, 'description' | 'category' | 'date' | 'walletId'>> & { amount?: number }) {
  const existing = await tx.transaction.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw new FinancialError('Transaction not found', 404);
  if (existing.savingsGoalId || existing.fixedExpenseId || existing.loanId || !['INCOME', 'EXPENSE', 'ADJUSTMENT'].includes(existing.type)) throw new FinancialError('Linked movements must be reversed and recreated', 409);
  const parsed = movementSchema.safeParse({ ...existing, amount: money(existing.amount), ...updates });
  if (!parsed.success) throw new FinancialError('Invalid transaction update');
  await requireWallet(tx, userId, parsed.data.walletId);
  await tx.transactionAudit.create({ data: { userId, transactionId: id, action: 'UPDATED', snapshot: jsonValue({ transaction: existing }) } });
  const updated = await tx.transaction.update({ where: { id }, data: updates });
  return { ...updated, amount: money(updated.amount) };
}

export async function requireNoActiveMovements(tx: FinancialTx, userId: string, link: Prisma.TransactionWhereInput) {
  if (await tx.transaction.count({ where: { userId, deletedAt: null, ...link } })) throw new FinancialError('Reverse the linked transactions before deleting or changing this financial record.', 409);
}
