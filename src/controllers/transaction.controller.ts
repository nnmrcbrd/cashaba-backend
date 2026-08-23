import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";
import { z } from "zod";

const transactionSchema = z.object({
    description: z.string().trim().min(1).max(200),
    type: z.enum(["INCOME", "EXPENSE"]),
    category: z.string().trim().min(1).max(50),
    amount: z.coerce.number().positive().finite(),
    date: z.string().optional().refine(
        (value) => !value || !Number.isNaN(new Date(value).getTime()),
        "A valid date is required",
    ),
    walletId: z.string().uuid().optional().nullable(),
});

const transactionUpdateSchema = transactionSchema.partial().refine(
    (data) => Object.keys(data).length > 0,
    "At least one field is required",
);

// CREATE transaction
export const createTransaction = async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId || req.user!.id;
        const parsed = transactionSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ message: "Invalid transaction", errors: parsed.error.flatten().fieldErrors });
        }
        const { description, type, category, amount, date, walletId } = parsed.data;
        if (walletId) {
            const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
            if (!wallet) return res.status(400).json({ message: "Selected account was not found" });
        }

        const transaction = await prisma.transaction.create({
            data: {
                description,
                type,
                category,
                amount,
                date: date ? new Date(date) : new Date(),
                userId,
                walletId: walletId || null,
            },
        });

        const safeToSpend = await recalculateSafeToSpend(userId);

        res.status(201).json({ ...transaction, safeToSpend });

    } catch (error) {
        console.error("createTransaction error:", error);
        res.status(500).json({ message: "Error creating transaction" });
    }
};

// GET all transactions of logged-in user
export const getTransactions = async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId || req.user!.id;
        const transactions = await prisma.transaction.findMany({
            where: {
                userId,
            },
            orderBy: {
                createdAt: "desc",
            },
            include: {
                wallet: {
                    select: { id: true, name: true, color: true },
                },
            },
        });

        res.json(transactions);

    } catch {
        res.status(500).json({ message: "Error fetching transactions" });
    }
};

// UPDATE
export const updateTransaction = async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId || req.user!.id;
        const id = req.params.id as string;
        const parsed = transactionUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ message: "Invalid transaction update", errors: parsed.error.flatten().fieldErrors });
        }
        const { amount, type, category, description, date, walletId } = parsed.data;

        // check if transaction belongs to user
        const existing = await prisma.transaction.findUnique({
            where: { id },
        });

        if (!existing || existing.userId !== userId) {
            return res.status(404).json({ message: "Transaction not found" });
        }
        if (walletId) {
            const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId } });
            if (!wallet) return res.status(400).json({ message: "Selected account was not found" });
        }

        const updated = await prisma.transaction.update({
            where: { id },
            data: {
                amount,
                type,
                category,
                description,
                date: date ? new Date(date) : undefined,
                walletId,
            },
        });

        const safeToSpend = await recalculateSafeToSpend(userId);

        res.json({ ...updated, safeToSpend });

    } catch {
        res.status(500).json({ message: "Error updating transaction" });
    }
};

// DELETE
export const deleteTransaction = async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId || req.user!.id;
        const id = req.params.id as string;

        const existing = await prisma.transaction.findUnique({
            where: { id },
        });

        if (!existing || existing.userId !== userId) {
            return res.status(404).json({ message: "Transaction not found" });
        }

        await prisma.transaction.delete({
            where: { id },
        });

        const safeToSpend = await recalculateSafeToSpend(userId);

        res.json({ message: "Transaction deleted successfully", safeToSpend });

    } catch {
        res.status(500).json({ message: "Error deleting transaction" });
    }
};
