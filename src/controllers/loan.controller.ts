import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { LoanRepaymentError, recordLoanPayment } from "@/services/loanRepayment";
import { z } from "zod";

const createLoanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  amount: z.coerce.number().positive().finite(),
  status: z.enum(["ACTIVE", "PAID_OFF", "OVERDUE"]).default("ACTIVE"),
  type: z.enum(["BORROWED", "LENT"]).default("BORROWED"),
  deadline: z.string().refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "A valid deadline is required",
  ),
  repaymentAmount: z.coerce.number().positive().finite().optional(),
  repaymentFrequency: z.enum(["WEEKLY", "MONTHLY", "ONE_TIME"]).default("ONE_TIME"),
});

const loanStatusSchema = z.object({
  status: z.enum(["ACTIVE", "PAID_OFF", "OVERDUE"]),
});

const repaymentSchema = z.object({
  amount: z.coerce.number().positive().finite(),
  date: z.string().optional().refine(
    (value) => !value || !Number.isNaN(new Date(value).getTime()),
    "A valid payment date is required",
  ),
  walletId: z.string().uuid().optional().nullable(),
});

export const getLoans = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const now = new Date();

    // 1. Auto-update active loans that past deadline to OVERDUE
    await prisma.loan.updateMany({
      where: {
        userId,
        status: "ACTIVE",
        deadline: { lt: now },
      },
      data: { status: "OVERDUE" },
    });

    // 2. Fetch all loans
    const loans = await prisma.loan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    // 3. Compute obligation summaries
    const totalBorrowed = loans
      .filter((l) => l.type === "BORROWED" && l.status !== "PAID_OFF")
      .reduce((sum, l) => sum + l.amount, 0);

    const totalLent = loans
      .filter((l) => l.type === "LENT" && l.status !== "PAID_OFF")
      .reduce((sum, l) => sum + l.amount, 0);

    const overdueCount = loans.filter((l) => l.status === "OVERDUE").length;
    const scheduledDue = loans
      .filter((l) => l.type === "BORROWED" && l.status !== "PAID_OFF" && l.deadline <= now)
      .reduce((sum, l) => sum + Math.min(l.repaymentAmount, Math.max(0, l.amount - l.amountPaid)), 0);

    res.json({
      loans,
      summary: {
        totalBorrowed,
        totalLent,
        overdueCount,
        scheduledDue,
      },
    });
  } catch (error) {
    console.error("Get loans error:", error);
    res.status(500).json({ message: "Error fetching loans" });
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
    const { title, amount, status, type, deadline, repaymentAmount, repaymentFrequency } = parsed.data;

    const loan = await prisma.loan.create({
      data: {
        userId,
        title,
        amount,
        status,
        type,
        startDate: new Date(),
        deadline: new Date(deadline),
        repaymentAmount: Math.min(repaymentAmount ?? amount, amount),
        repaymentFrequency,
      },
    });

    res.status(201).json(loan);
  } catch (error) {
    console.error("Create loan error:", error);
    res.status(500).json({ message: "Error creating loan" });
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
    const result = await recordLoanPayment({ userId, loanId: id, amount, paidAt, walletId });
    return res.json(result);
  } catch (error) {
    console.error("Record loan repayment error:", error);
    if (error instanceof LoanRepaymentError) {
      return res.status(error.status).json({ message: error.message });
    }
    return res.status(500).json({ message: "Error recording loan repayment" });
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

    const existing = await prisma.loan.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Loan not found" });
    }

    const updated = await prisma.loan.update({
      where: { id },
      data: { status },
    });

    res.json(updated);
  } catch (error) {
    console.error("Update loan status error:", error);
    res.status(500).json({ message: "Error updating loan status" });
  }
};

export const deleteLoan = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;

    const existing = await prisma.loan.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Loan not found" });
    }

    await prisma.loan.delete({ where: { id } });
    res.json({ message: "Loan deleted successfully" });
  } catch (error) {
    console.error("Delete loan error:", error);
    res.status(500).json({ message: "Error deleting loan" });
  }
};
