import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";

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

    res.json({
      loans,
      summary: {
        totalBorrowed,
        totalLent,
        overdueCount,
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
    const { title, amount, status, type, deadline } = req.body;

    if (!title || !amount) {
      return res.status(400).json({ message: "title and amount are required" });
    }

    const loan = await prisma.loan.create({
      data: {
        userId,
        title,
        amount: Number(amount),
        status: status || "ACTIVE",
        type: type || "BORROWED",
        startDate: new Date(),
        deadline: deadline ? new Date(deadline) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    res.status(201).json(loan);
  } catch (error) {
    console.error("Create loan error:", error);
    res.status(500).json({ message: "Error creating loan" });
  }
};

export const updateLoanStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;
    const { status } = req.body;

    if (!status || !["ACTIVE", "PAID_OFF", "OVERDUE"].includes(status)) {
      return res.status(400).json({ message: "Valid status required (ACTIVE | PAID_OFF | OVERDUE)" });
    }

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
