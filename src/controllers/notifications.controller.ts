import { businessMonth } from "@/utils/calendar";
import { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { calculateSafeToSpend } from "@/utils/safeToSpend";
import { money } from "@/utils/money";

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
    const calendar = businessMonth(now);
    const monthStart = calendar.start, monthEnd = calendar.end;
    const [budget, loans, obligations, setup, monthlyExpenses] = await Promise.all([
      prisma.budget.findUnique({
        where: { userId_month_year: { userId, month: calendar.month, year: calendar.year } },
      }),
      prisma.loan.findMany({
        where: { userId, status: { in: ["ACTIVE", "OVERDUE"] } },
      }),
      prisma.fixedExpense.findMany({
        where: { userId, status: { in: ["PENDING", "PARTIALLY_PAID", "OVERDUE"] } },
      }),
      prisma.incomeSetup.findUnique({ where: { userId } }),
      prisma.transaction.aggregate({
        where: { userId, type: { in: ["EXPENSE", "BILL_PAYMENT", "DEBT_PAYMENT"] }, deletedAt: null, date: { gte: monthStart, lt: monthEnd } },
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
    if (budget && money(budget.targetAmount) > 0) {
      const amountSpent = money(monthlyExpenses._sum.amount);
      const targetAmount = money(budget.targetAmount);
      const spentPct = (amountSpent / targetAmount) * 100;
      if (spentPct >= 100) {
        notifications.push({
          id: "budget-exceeded",
          type: "danger",
          title: "🚨 Budget Exceeded!",
          message: `You've spent ₱${amountSpent.toLocaleString()} — ${Math.round(spentPct)}% of your ₱${targetAmount.toLocaleString()} monthly budget.`,
        });
      } else if (spentPct >= 80) {
        notifications.push({
          id: "budget-warning",
          type: "warning",
          title: "⚠️ Near Budget Limit",
          message: `You've used ${Math.round(spentPct)}% of your monthly budget. Only ₱${Math.max(targetAmount - amountSpent, 0).toLocaleString()} remaining.`,
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

    const overdueObligations = obligations.filter((item) => item.status === "OVERDUE" || (item.dueDate !== null && item.dueDate < now));
    if (overdueObligations.length > 0) {
      notifications.push({ id: "obligations-overdue", type: "danger", title: "Bills overdue", message: `${overdueObligations.length} bill or recurring obligation${overdueObligations.length === 1 ? " is" : "s are"} overdue.` });
    }
    const upcomingObligations = obligations.filter((item) => {
      if (!item.dueDate) return false;
      const days = (item.dueDate.getTime() - now.getTime()) / 86_400_000;
      return days >= 0 && days <= item.reminderDays;
    });
    if (upcomingObligations.length > 0) {
      notifications.push({ id: "obligations-upcoming", type: "warning", title: "Bills due soon", message: `${upcomingObligations.length} obligation${upcomingObligations.length === 1 ? " is" : "s are"} within its reminder window.` });
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
