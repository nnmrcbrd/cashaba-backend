import { Request, Response } from "express";
import prisma from "@/prisma/client";

// CREATE transaction
export const createTransaction = async (req: Request, res: Response) => {
    try {
        const { description, type, category, amount, date } = req.body;

        const transaction = await prisma.transaction.create({
            data: {
                description,
                type,
                category,
                amount,
                date: date ? new Date(date) : new Date(),
                userId: req.user!.id, // comes from auth middleware
            },
        });

        res.status(201).json(transaction);

    } catch (error) {
        res.status(500).json({ message: "Error creating transaction" });
    }
};

// GET all transactions of logged-in user
export const getTransactions = async (req: Request, res: Response) => {
    try {
        const transactions = await prisma.transaction.findMany({
            where: {
                userId: req.user!.id,
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
        const id = req.params.id as string;
        const { amount, type, category, description, date } = req.body;

        // check if transaction belongs to user
        const existing = await prisma.transaction.findUnique({
            where: { id },
        });

        if (!existing || existing.userId !== req.user!.id) {
            return res.status(404).json({ message: "Transaction not found" });
        }

        const updated = await prisma.transaction.update({
            where: { id },
            data: {
                amount,
                type,
                category,
                description,
                date: date ? new Date(date) : undefined,
            },
        });

        res.json(updated);

    } catch (error) {
        res.status(500).json({ message: "Error updating transaction" });
    }
};

// DELETE
export const deleteTransaction = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;

        const existing = await prisma.transaction.findUnique({
            where: { id },
        });

        if (!existing || existing.userId !== req.user!.id) {
            return res.status(404).json({ message: "Transaction not found" });
        }

        await prisma.transaction.delete({
            where: { id },
        });

        res.json({ message: "Transaction deleted successfully" });

    } catch (error) {
        res.status(500).json({ message: "Error deleting transaction" });
    }
};
