import { prisma } from "@/lib/prisma";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";

export class LoanRepaymentError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
  }
}

function nextDueDate(currentDueDate: Date, frequency: string) {
  const next = new Date(currentDueDate);
  if (frequency === "WEEKLY") next.setDate(next.getDate() + 7);
  if (frequency === "MONTHLY") next.setMonth(next.getMonth() + 1);
  return next;
}

export async function recordLoanPayment(input: {
  userId: string;
  loanId: string;
  amount: number;
  paidAt: Date;
  walletId?: string | null;
}) {
  const { userId, loanId, amount, paidAt, walletId } = input;
  const loan = await prisma.loan.findFirst({ where: { id: loanId, userId } });
  if (!loan) throw new LoanRepaymentError("Loan not found", 404);
  if (loan.status === "PAID_OFF") throw new LoanRepaymentError("This loan is already paid off");

  const remaining = Math.max(0, loan.amount - loan.amountPaid);
  if (amount > remaining) {
    throw new LoanRepaymentError(`Payment cannot exceed the remaining balance of ${remaining}`);
  }
  if (walletId) {
    const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
    if (!wallet) throw new LoanRepaymentError("Selected account was not found");
  }

  const newAmountPaid = loan.amountPaid + amount;
  const isPaidOff = newAmountPaid >= loan.amount;
  const advancedDeadline = nextDueDate(loan.deadline, loan.repaymentFrequency);
  const nextStatus = isPaidOff
    ? "PAID_OFF"
    : advancedDeadline < new Date()
      ? "OVERDUE"
      : "ACTIVE";

  const result = await prisma.$transaction(async (tx) => {
    const transaction = await tx.transaction.create({
      data: {
        userId,
        loanId: loan.id,
        walletId: walletId || null,
        description: loan.type === "BORROWED" ? `Loan payment: ${loan.title}` : `Loan collection: ${loan.title}`,
        type: loan.type === "BORROWED" ? "EXPENSE" : "INCOME",
        category: loan.type === "BORROWED" ? "Debt Repayment" : "Loan Collection",
        amount,
        date: paidAt,
      },
    });

    const updatedLoan = await tx.loan.update({
      where: { id: loan.id },
      data: {
        amountPaid: newAmountPaid,
        status: nextStatus,
        ...(isPaidOff || loan.repaymentFrequency === "ONE_TIME" ? {} : { deadline: advancedDeadline }),
      },
    });

    return { transaction, loan: updatedLoan, remaining: Math.max(0, updatedLoan.amount - updatedLoan.amountPaid) };
  });

  const safeToSpend = await recalculateSafeToSpend(userId);
  return { ...result, safeToSpend };
}
