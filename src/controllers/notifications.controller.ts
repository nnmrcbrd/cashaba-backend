import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { calculateSafeToSpend } from "@/utils/safeToSpend";

/**
 * GET /api/notifications
 * Returns active alert objects for the authenticated user.
 * Checks: budget thresholds, overdue loans, low safe-to-spend.
 * Read-only — does not mutate existing data.
 */
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const [budget, loans, setup, monthlyExpenses] = await Promise.all([
      prisma.budget.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.loan.findMany({
        where: { userId, status: { in: ["ACTIVE", "OVERDUE"] } },
      }),
      prisma.incomeSetup.findUnique({ where: { userId } }),
      prisma.transaction.aggregate({
        where: { userId, type: "EXPENSE", date: { gte: monthStart, lt: monthEnd } },
        _sum: { amount: true },
      }),
    ]);

    const notifications: {
      id: string;
      type: "warning" | "danger" | "info";
      title: string;
      message: string;
    }[] = [];

    // Budget threshold alerts
    if (budget && budget.targetAmount > 0) {
      const amountSpent = monthlyExpenses._sum.amount || 0;
      const spentPct = (amountSpent / budget.targetAmount) * 100;
      if (spentPct >= 100) {
        notifications.push({
          id: "budget-exceeded",
          type: "danger",
          title: "🚨 Budget Exceeded!",
          message: `You've spent ₱${amountSpent.toLocaleString()} — ${Math.round(spentPct)}% of your ₱${budget.targetAmount.toLocaleString()} monthly budget.`,
        });
      } else if (spentPct >= 80) {
        notifications.push({
          id: "budget-warning",
          type: "warning",
          title: "⚠️ Near Budget Limit",
          message: `You've used ${Math.round(spentPct)}% of your monthly budget. Only ₱${Math.max(budget.targetAmount - amountSpent, 0).toLocaleString()} remaining.`,
        });
      }
    }

    // Overdue loan alerts
    const overdueLoans = loans.filter(
      (l) => l.status === "OVERDUE" || (l.deadline < now && l.status === "ACTIVE")
    );
    if (overdueLoans.length > 0) {
      notifications.push({
        id: "loans-overdue",
        type: "danger",
        title: "🔴 Overdue Payments",
        message: `${overdueLoans.length} loan${overdueLoans.length > 1 ? "s are" : " is"} past due. Review your Debts & Loans page.`,
      });
    }

    // Upcoming loan due dates (within 3 days)
    const soonLoans = loans.filter((l) => {
      const diff = (l.deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return diff >= 0 && diff <= 3 && l.status === "ACTIVE";
    });
    if (soonLoans.length > 0 && overdueLoans.length === 0) {
      notifications.push({
        id: "loans-due-soon",
        type: "warning",
        title: "📅 Payment Due Soon",
        message: `${soonLoans.length} loan${soonLoans.length > 1 ? "s" : ""} due within 3 days. Don't forget to pay!`,
      });
    }

    const safeBreakdown = setup ? await calculateSafeToSpend(userId) : null;

    // The persisted value is clamped to zero, so use the raw calculation to
    // distinguish low funds from overspending.
    if (safeBreakdown && safeBreakdown.rawSafeToSpend < 0) {
      notifications.push({
        id: "negative-safe-to-spend",
        type: "danger",
        title: "🚨 Overspent This Period",
        message: "Your obligations and spending have exceeded your income for this period. Review your expenses immediately.",
      });
    } else if (safeBreakdown && safeBreakdown.safeToSpend < 500) {
      notifications.push({
        id: "low-safe-to-spend",
        type: "warning",
        title: "💸 Low Safe-to-Spend",
        message: `Your Safe-to-Spend is ₱${safeBreakdown.safeToSpend.toLocaleString()}. Consider limiting discretionary spending.`,
      });
    }

    res.json({ notifications, count: notifications.length });
  } catch (error) {
    console.error("getNotifications error:", error);
    res.status(500).json({ message: "Error fetching notifications" });
  }
};
