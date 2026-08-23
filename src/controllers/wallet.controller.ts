import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const walletSchema = z.object({
  name: z.string().trim().min(1).max(60),
  institution: z.string().trim().max(80).optional().nullable(),
  accountType: z.enum(["CASH", "BANK", "EWALLET", "CREDIT_CARD", "INVESTMENT", "OTHER"]),
  kind: z.enum(["ASSET", "LIABILITY"]),
  openingBalance: z.coerce.number().min(0).finite(),
  icon: z.enum(["wallet", "bank", "phone", "card", "chart", "other"]).default("wallet"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#0f766e"),
});

const walletUpdateSchema = walletSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  "At least one field is required",
);

function withBalance<T extends {
  openingBalance: number;
  kind: string;
  transactions: Array<{ type: "INCOME" | "EXPENSE"; amount: number }>;
}>(wallet: T) {
  const activity = wallet.transactions.reduce(
    (total, transaction) =>
      total + (transaction.type === "INCOME" ? transaction.amount : -transaction.amount),
    0,
  );
  const balance =
    wallet.kind === "LIABILITY"
      ? Math.max(0, wallet.openingBalance - activity)
      : wallet.openingBalance + activity;

  const { transactions: _transactions, ...account } = wallet;
  return { ...account, balance };
}

export const getWallets = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const wallets = await prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
        transactions: { select: { type: true, amount: true } },
      },
    });
    res.json(wallets.map(withBalance));
  } catch (error) {
    console.error("getWallets error:", error);
    res.status(500).json({ message: "Error fetching accounts" });
  }
};

export const createWallet = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const parsed = walletSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid account details",
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const wallet = await prisma.wallet.create({
      data: {
        ...parsed.data,
        institution: parsed.data.institution || null,
        userId,
      },
    });
    res.status(201).json({ ...wallet, balance: wallet.openingBalance });
  } catch (error) {
    console.error("createWallet error:", error);
    res.status(500).json({ message: "Error creating account" });
  }
};

export const updateWallet = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;
    const parsed = walletUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: "Invalid account update",
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const existing = await prisma.wallet.findFirst({ where: { id, userId } });
    if (!existing) return res.status(404).json({ message: "Account not found" });

    const wallet = await prisma.wallet.update({
      where: { id },
      data: {
        ...parsed.data,
        ...(parsed.data.institution !== undefined
          ? { institution: parsed.data.institution || null }
          : {}),
      },
      include: {
        transactions: { select: { type: true, amount: true } },
      },
    });
    res.json(withBalance(wallet));
  } catch (error) {
    console.error("updateWallet error:", error);
    res.status(500).json({ message: "Error updating account" });
  }
};

export const deleteWallet = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;
    const existing = await prisma.wallet.findFirst({ where: { id, userId } });
    if (!existing) return res.status(404).json({ message: "Account not found" });

    await prisma.wallet.delete({ where: { id } });
    res.json({ message: "Account deleted; its transactions are now unassigned" });
  } catch (error) {
    console.error("deleteWallet error:", error);
    res.status(500).json({ message: "Error deleting account" });
  }
};
