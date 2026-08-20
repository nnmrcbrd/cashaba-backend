import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/notifications
 * Returns active alert objects for the authenticated user.
 * Checks: budget thresholds, overdue loans, low safe-to-spend.
 * Read-only — does not mutate existing data.
 */
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;

    const [budget, loans, setup] = await Promise.all([
      prisma.budget.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      prisma.loan.findMany({
        where: { userId, status: { in: ["ACTIVE", "OVERDUE"] } },
      }),
      prisma.incomeSetup.findUnique({ where: { userId } }),
    ]);

    const notifications: {
      id: string;
      type: "warning" | "danger" | "info";
      title: string;
      message: string;
    }[] = [];

    // Budget threshold alerts
    if (budget && budget.targetAmount > 0) {
      const spentPct = (budget.amountSpent / budget.targetAmount) * 100;
      if (spentPct >= 100) {
        notifications.push({
          id: "budget-exceeded",
          type: "danger",
          title: "🚨 Budget Exceeded!",
          message: `You've spent ₱${budget.amountSpent.toLocaleString()} — ${Math.round(spentPct)}% of your ₱${budget.targetAmount.toLocaleString()} monthly budget.`,
        });
      } else if (spentPct >= 80) {
        notifications.push({
          id: "budget-warning",
          type: "warning",
          title: "⚠️ Near Budget Limit",
          message: `You've used ${Math.round(spentPct)}% of your monthly budget. Only ₱${(budget.targetAmount - budget.amountSpent).toLocaleString()} remaining.`,
        });
      }
    }

    // Overdue loan alerts
    const now = new Date();
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

    // Low safe-to-spend alert
    if (setup && setup.safeToSpend < 500 && setup.safeToSpend >= 0) {
      notifications.push({
        id: "low-safe-to-spend",
        type: "warning",
        title: "💸 Low Safe-to-Spend",
        message: `Your Safe-to-Spend is ₱${setup.safeToSpend.toLocaleString()}. Consider limiting discretionary spending.`,
      });
    }
    if (setup && setup.safeToSpend < 0) {
      notifications.push({
        id: "negative-safe-to-spend",
        type: "danger",
        title: "🚨 Overspent This Period",
        message: `Your spending has exceeded your income for this period. Review your expenses immediately.`,
      });
    }

    res.json({ notifications, count: notifications.length });
  } catch (error) {
    console.error("getNotifications error:", error);
    res.status(500).json({ message: "Error fetching notifications" });
  }
};
