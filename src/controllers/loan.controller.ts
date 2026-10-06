import { isFinancialDate } from "@/utils/calendar";
import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { LoanRepaymentError, recordLoanPayment } from "@/services/loanRepayment";
import { z } from "zod";
import { FinancialError, financialResponse, requestOperation, withFinancialOperation } from '@/services/financialOperation';
import { requireNoActiveMovements } from '@/services/movements';
import { positiveMoney } from '@/schema/movement';
import { money } from "@/utils/money";

function loanJson<T extends { amount: unknown; amountPaid: unknown; installmentPaid: unknown; repaymentAmount: unknown }>(loan: T) {
  return { ...loan, amount: money(loan.amount), amountPaid: money(loan.amountPaid), installmentPaid: money(loan.installmentPaid), repaymentAmount: money(loan.repaymentAmount) };
}

const createLoanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  amount: positiveMoney,
  status: z.enum(["ACTIVE", "PAID_OFF", "OVERDUE"]).default("ACTIVE"),
  type: z.enum(["BORROWED", "LENT"]).default("BORROWED"),
  deadline: z.string().refine(
    (value) => isFinancialDate(value),
    "A valid deadline is required",
  ),
  repaymentAmount: positiveMoney.optional(),
  repaymentFrequency: z.enum(["WEEKLY", "MONTHLY", "ONE_TIME"]).default("ONE_TIME"),
  walletId: z.string().uuid().optional().nullable(),
  principalAlreadyIncluded: z.boolean().default(false),
}).refine(data => data.principalAlreadyIncluded || Boolean(data.walletId), { path: ['walletId'], message: 'Select the account that received or sent the money' });

const loanStatusSchema = z.object({
  status: z.enum(["ACTIVE", "PAID_OFF", "OVERDUE"]),
});

const repaymentSchema = z.object({
  amount: positiveMoney,
  date: z.string().optional().refine(
    (value) => !value || isFinancialDate(value),
    "A valid payment date is required",
  ),
  walletId: z.string().uuid(),
});

export const getLoans = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const now = new Date();

    // 2. Fetch all loans
    const storedLoans = await prisma.loan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const loans = storedLoans.map(loan => ({ ...loan, status: loan.status === 'ACTIVE' && loan.deadline < now ? 'OVERDUE' as const : loan.status }));
    // 3. Compute obligation summaries
    const totalBorrowed = loans
      .filter((l) => l.type === "BORROWED" && l.status !== "PAID_OFF")
      .reduce((sum, l) => sum + Math.max(0, money(l.amount) - money(l.amountPaid)), 0);

    const totalLent = loans
      .filter((l) => l.type === "LENT" && l.status !== "PAID_OFF")
      .reduce((sum, l) => sum + Math.max(0, money(l.amount) - money(l.amountPaid)), 0);

    const overdueCount = loans.filter((l) => l.status === "OVERDUE").length;
    const scheduledDue = loans
      .filter((l) => l.type === "BORROWED" && l.status !== "PAID_OFF" && l.deadline <= now)
      .reduce((sum, l) => sum + Math.min(Math.max(0, money(l.repaymentAmount) - money(l.installmentPaid)), Math.max(0, money(l.amount) - money(l.amountPaid))), 0);

    res.json({
      loans: loans.map(loanJson),
      summary: {
        totalBorrowed,
        totalLent,
        overdueCount,
        scheduledDue,
      },
    });
  } catch (error) {
    console.error("Get loans error:", error);
    financialResponse(res, error, 'Error fetching loans');
  }
};

export const createLoan = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const parsed = createLoanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid loan details",
        errors: parsed.error.flatten().fieldErrors,
      });
    }
    const { title, amount, type, deadline, repaymentAmount, repaymentFrequency, walletId, principalAlreadyIncluded } = parsed.data;
    if (parsed.data.status === 'PAID_OFF') throw new FinancialError('Record repayments to mark a loan paid');
    const status = new Date(deadline) < new Date() ? 'OVERDUE' : 'ACTIVE';

    const loan = await withFinancialOperation(userId, async tx => {
      if (!principalAlreadyIncluded) {
        const wallet = await tx.wallet.findFirst({ where: { id: walletId!, userId } });
        if (!wallet) throw new FinancialError('Wallet not found', 404);
        if (wallet.kind !== 'ASSET') throw new FinancialError('Borrowed or lent money must use a cash, bank, or e-wallet asset account');
      }
      const created = await tx.loan.create({ data: {
        userId,
        title,
        amount,
        status,
        type,
        startDate: new Date(),
        deadline: new Date(deadline),
        scheduleAnchor: new Date(deadline),
        repaymentAmount: Math.min(repaymentAmount ?? amount, amount),
        repaymentFrequency,
      }});
      if (!principalAlreadyIncluded) {
        const movement = await tx.transaction.create({ data: {
          userId,
          walletId: walletId!,
          loanId: created.id,
          description: type === 'BORROWED' ? `Borrowed money received: ${title}` : `Money lent out: ${title}`,
          category: type === 'BORROWED' ? 'Borrowed Money' : 'Money Lent',
          type: type === 'BORROWED' ? 'LOAN_PROCEEDS' : 'LOAN_DISBURSEMENT',
          amount,
          date: new Date(),
        }});
        await tx.transactionAudit.create({ data: { userId, transactionId: movement.id, action: 'CREATED', snapshot: { transaction: { ...movement, amount: String(movement.amount) }, relatedBefore: null } } });
      }
      return created;
    }, requestOperation(req));

    res.status(201).json(loanJson(loan));
  } catch (error) {
    console.error("Create loan error:", error);
    financialResponse(res, error, 'Error creating loan');
  }
};

export const recordLoanRepayment = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;
    const parsed = repaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid repayment", errors: parsed.error.flatten().fieldErrors });
    }

    const { amount, date, walletId } = parsed.data;
    const paidAt = date ? new Date(date) : new Date();
    const result = await recordLoanPayment({ userId, loanId: id, amount, paidAt, walletId }, requestOperation(req));
    return res.json(result);
  } catch (error) {
    console.error("Record loan repayment error:", error);
    if (error instanceof LoanRepaymentError) {
      return res.status(error.status).json({ message: error.message });
    }
    return financialResponse(res, error, 'Error recording loan repayment');
  }
};

export const updateLoanStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;
    const parsed = loanStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Valid status required (ACTIVE | PAID_OFF | OVERDUE)" });
    }
    const { status } = parsed.data;

    const updated = await withFinancialOperation(userId, async tx => {
      const existing = await tx.loan.findFirst({ where: { id, userId } });
      if (!existing) throw new FinancialError('Loan not found', 404);
      const expected = money(existing.amountPaid) >= money(existing.amount) ? 'PAID_OFF' : existing.deadline < new Date() ? 'OVERDUE' : 'ACTIVE';
      if (status !== expected) throw new FinancialError('Loan status is determined by recorded payments and its due date');
      return tx.loan.update({ where: { id }, data: { status } });
    }, requestOperation(req));

    res.json(loanJson(updated));
  } catch (error) {
    console.error("Update loan status error:", error);
    financialResponse(res, error, 'Error updating loan status');
  }
};

export const deleteLoan = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;

    await withFinancialOperation(userId, async tx => {
      if (!await tx.loan.findFirst({ where: { id, userId } })) throw new FinancialError('Loan not found', 404);
      await requireNoActiveMovements(tx, userId, { loanId: id, type: { in: ['DEBT_PAYMENT', 'LOAN_COLLECTION'] } });
      const principal = await tx.transaction.findMany({ where: { userId, loanId: id, deletedAt: null, type: { in: ['LOAN_PROCEEDS', 'LOAN_DISBURSEMENT'] } } });
      for (const movement of principal) {
        await tx.transaction.update({ where: { id: movement.id }, data: { deletedAt: new Date() } });
        await tx.transactionAudit.create({ data: { userId, transactionId: movement.id, action: 'DELETED', snapshot: { transaction: { ...movement, amount: String(movement.amount) } } } });
      }
      return tx.loan.delete({ where: { id } });
    }, requestOperation(req));
    res.json({ message: "Loan deleted successfully" });
  } catch (error) {
    console.error("Delete loan error:", error);
    financialResponse(res, error, 'Error deleting loan');
  }
};
