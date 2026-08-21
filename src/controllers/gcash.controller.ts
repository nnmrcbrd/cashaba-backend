import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { detectCategory } from "@/utils/detectCategory";
import { parseGCashCSV } from "@/utils/gcashParser";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";

export const importGCashTransactions = async (
    req: Request,
    res: Response
) => {
    try {
        const userId = req.user!.userId || req.user!.id;

        if (!req.file) {
            return res.status(400).json({
                message: "Please upload a GCash CSV file",
            });
        }

        const rows = await parseGCashCSV(req.file.buffer);

        if (rows.length === 0) {
            return res.status(400).json({
                message: "No transactions were found in the uploaded file",
            });
        }

        const parsedTransactions = rows.map((row) => ({
            userId,
            type: row.amount < 0 ? ("EXPENSE" as const) : ("INCOME" as const),
            amount: Math.abs(row.amount),
            category: detectCategory(row.description),
            description: row.description,
            date: new Date(row.date),
        }));

        await prisma.transaction.createMany({
            data: parsedTransactions,
        });

        const safeToSpend = await recalculateSafeToSpend(userId);

        res.status(201).json({
            message: "GCash transactions imported successfully",
            count: parsedTransactions.length,
            safeToSpend,
        });
    } catch (error) {
        console.error("GCash import error:", error);

        res.status(500).json({
            message: "Failed to import GCash transactions",
        });
    }
};
