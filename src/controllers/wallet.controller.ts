import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";

const DEFAULT_WALLETS = [
  { name: "GCash", icon: "📱", color: "#1BA4E6" },
  { name: "Cash on Hand", icon: "💵", color: "#10b981" },
  { name: "BDO", icon: "🏦", color: "#C41E3A" },
  { name: "Maya", icon: "💳", color: "#0066CC" },
];

/** GET /api/wallets — list user's wallets */
export const getWallets = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    let wallets = await prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    // Auto-seed default wallets for new users
    if (wallets.length === 0) {
      const created = await Promise.all(
        DEFAULT_WALLETS.map((w) =>
          prisma.wallet.create({ data: { ...w, userId } })
        )
      );
      wallets = created;
    }

    res.json(wallets);
  } catch (error) {
    console.error("getWallets error:", error);
    res.status(500).json({ message: "Error fetching wallets" });
  }
};

/** POST /api/wallets — create a new wallet */
export const createWallet = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const { name, icon, color } = req.body;

    if (!name) return res.status(400).json({ message: "Wallet name required" });

    const wallet = await prisma.wallet.create({
      data: { userId, name, icon: icon || "💳", color: color || "#10b981" },
    });
    res.status(201).json(wallet);
  } catch (error) {
    console.error("createWallet error:", error);
    res.status(500).json({ message: "Error creating wallet" });
  }
};

/** DELETE /api/wallets/:id — delete a wallet */
export const deleteWallet = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const id = req.params.id as string;

    const existing = await prisma.wallet.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ message: "Wallet not found" });
    }

    await prisma.wallet.delete({ where: { id } });
    res.json({ message: "Wallet deleted" });
  } catch (error) {
    console.error("deleteWallet error:", error);
    res.status(500).json({ message: "Error deleting wallet" });
  }
};
