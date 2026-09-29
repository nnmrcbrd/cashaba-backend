import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { money, roundMoney } from "@/utils/money";
import { z } from "zod";
import { FinancialError, financialResponse, requestOperation, withFinancialOperation } from '@/services/financialOperation';
import { requireNoActiveMovements } from '@/services/movements';

const walletFields = z.object({
  name: z.string().trim().min(1).max(60),
  institution: z.string().trim().max(80).optional().nullable(),
  accountType: z.enum(["CASH", "BANK", "EWALLET", "CREDIT_CARD", "INVESTMENT", "OTHER"]),
  customType: z.string().trim().max(40).optional().nullable(),
  kind: z.enum(["ASSET", "LIABILITY"]),
  openingBalance: z.coerce.number().min(0).finite(),
  icon: z.enum(["wallet", "bank", "phone", "card", "chart", "other"]).default("wallet"),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#0f766e"),
});
const customTypeRequired = { path: ["customType"] as ["customType"], message: "Name the account type when choosing Other" };
const walletSchema = walletFields.refine(
  (data) => data.accountType !== "OTHER" || Boolean(data.customType?.trim()),
  customTypeRequired,
);

const walletUpdateSchema = walletFields.partial()
  .refine((data) => Object.keys(data).length > 0, "At least one field is required")
  .refine((data) => data.accountType !== "OTHER" || Boolean(data.customType?.trim()), customTypeRequired);

type Movement = { type: string; amount: unknown; category: string };

export function calculateWalletBalance(input: {
  openingBalance: unknown;
  kind: string;
  transactions: Movement[];
  incomingTransfers: Array<{ amount: unknown }>;
}) {
  let balance = money(input.openingBalance);
  for (const transaction of input.transactions) {
    const amount = money(transaction.amount);
    const isDecreaseAdjustment = transaction.type === "ADJUSTMENT" && transaction.category === "Balance Decrease";
    if (input.kind === "LIABILITY") {
      if (["EXPENSE", "TRANSFER", "SAVINGS_CONTRIBUTION", "BILL_PAYMENT", "DEBT_PAYMENT"].includes(transaction.type) || (transaction.type === "ADJUSTMENT" && !isDecreaseAdjustment)) balance += amount;
      else balance -= amount;
    } else if (["INCOME", "SAVINGS_WITHDRAWAL", "LOAN_COLLECTION", "LOAN_PROCEEDS"].includes(transaction.type) || (transaction.type === "ADJUSTMENT" && !isDecreaseAdjustment)) {
      balance += amount;
    } else {
      balance -= amount;
    }
  }
  const incoming = input.incomingTransfers.reduce((sum, transaction) => sum + money(transaction.amount), 0);
  balance += input.kind === "LIABILITY" ? -incoming : incoming;
  return roundMoney(balance);
}

function serializeWallet<T extends {
  openingBalance: unknown;
  kind: string;
  transactions: Movement[];
  incomingTransfers: Array<{ amount: unknown }>;
}>(wallet: T) {
  const balance = calculateWalletBalance(wallet);
  const { transactions: _transactions, incomingTransfers: _incomingTransfers, ...account } = wallet;
  return { ...account, openingBalance: money(wallet.openingBalance), balance };
}

const movementInclude = {
  transactions: { where: { deletedAt: null }, select: { type: true, amount: true, category: true } },
  incomingTransfers: { where: { deletedAt: null, type: "TRANSFER" }, select: { amount: true } },
} as const;

export const getWallets = async (req: Request, res: Response) => {
  try {
    const wallets = await prisma.wallet.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: "asc" }, include: movementInclude });
    res.json(wallets.map(serializeWallet));
  } catch (error) {
    console.error("getWallets error:", error);
    financialResponse(res, error, 'Error fetching accounts');
  }
};

export const createWallet = async (req: Request, res: Response) => {
  try {
    const parsed = walletSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid account details", errors: parsed.error.flatten().fieldErrors });
    const wallet = await withFinancialOperation(req.user!.userId, tx => tx.wallet.create({ data: { ...parsed.data, institution: parsed.data.institution || null, userId: req.user!.userId } }), requestOperation(req));
    res.status(201).json({ ...wallet, openingBalance: money(wallet.openingBalance), balance: money(wallet.openingBalance) });
  } catch (error) {
    console.error("createWallet error:", error);
    financialResponse(res, error, 'Error creating account');
  }
};

export const updateWallet = async (req: Request, res: Response) => {
  try {
    const parsed = walletUpdateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid account update", errors: parsed.error.flatten().fieldErrors });
    const id = req.params.id as string;
    const wallet = await withFinancialOperation(req.user!.userId, async tx => {
      const existing = await tx.wallet.findFirst({ where: { id, userId: req.user!.userId } });
      if (!existing) throw new FinancialError('Account not found', 404);
      if (parsed.data.kind && parsed.data.kind !== existing.kind) await requireNoActiveMovements(tx, req.user!.userId, { OR: [{ walletId: id }, { destinationWalletId: id }] });
      return tx.wallet.update({ where: { id }, data: { ...parsed.data, ...(parsed.data.institution !== undefined ? { institution: parsed.data.institution || null } : {}) }, include: movementInclude });
    }, requestOperation(req));
    res.json(serializeWallet(wallet));
  } catch (error) {
    console.error("updateWallet error:", error);
    financialResponse(res, error, 'Error updating account');
  }
};

export const deleteWallet = async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await withFinancialOperation(req.user!.userId, async tx => {
      if (!await tx.wallet.findFirst({ where: { id, userId: req.user!.userId } })) throw new FinancialError('Account not found', 404);
      await requireNoActiveMovements(tx, req.user!.userId, { OR: [{ walletId: id }, { destinationWalletId: id }] });
      return tx.wallet.delete({ where: { id } });
    }, requestOperation(req));
    res.json({ message: "Account deleted; linked transactions remain in your audit history" });
  } catch (error) {
    console.error("deleteWallet error:", error);
    financialResponse(res, error, 'Error deleting account');
  }
};
