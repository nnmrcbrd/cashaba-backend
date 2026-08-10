import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";

// CREATE transaction
export const createTransaction = async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId || req.user!.id;
        const { description, type, category, amount, date } = req.body;

        const transaction = await prisma.transaction.create({
            data: {
                description,
                type,
                category,
                amount: parseFloat(amount),
                date: date ? new Date(date) : new Date(),
                userId,
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
        });

        res.json(transactions);

    } catch (error) {
        res.status(500).json({ message: "Error fetching transactions" });
    }
};

// UPDATE
export const updateTransaction = async (req: Request, res: Response) => {
    try {
        const userId = req.user!.userId || req.user!.id;
        const id = req.params.id as string;
        const { amount, type, category, description, date } = req.body;

        // check if transaction belongs to user
        const existing = await prisma.transaction.findUnique({
            where: { id },
        });

        if (!existing || existing.userId !== userId) {
            return res.status(404).json({ message: "Transaction not found" });
        }

        const updated = await prisma.transaction.update({
            where: { id },
            data: {
                amount: amount ? parseFloat(amount) : undefined,
                type,
                category,
                description,
                date: date ? new Date(date) : undefined,
            },
        });

        const safeToSpend = await recalculateSafeToSpend(userId);

        res.json({ ...updated, safeToSpend });

    } catch (error) {
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

    } catch (error) {
        res.status(500).json({ message: "Error deleting transaction" });
    }
};
