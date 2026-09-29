import { Request, Response } from "express";
import { createHash } from 'node:crypto';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";
import { money } from "@/utils/money";
import { calculateSafeToSpend } from '@/utils/safeToSpend';
import { getSubscriptionSummary } from '@/services/subscription';

/**
 * GET /api/ai/insights
 * Analyzes the user's recent transactions and returns 3-4 personalized AI insight cards.
 * Read-only — does not mutate any existing data.
 */
export const getFinancialInsights = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;

    const setup = await calculateSafeToSpend(userId);
    // Every insight uses the same current income period as Safe-to-Spend, so
    // totals never mix unrelated weeks or months.
    const [transactions, savingsGoals, loans] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          userId,
          deletedAt: null,
          date: { gte: new Date(setup.periodStart), lt: new Date(setup.periodEnd) },
        },
        orderBy: { date: "desc" },
      }),
      prisma.savingsGoal.findMany({ where: { userId } }),
      prisma.loan.findMany({ where: { userId, type: 'BORROWED', status: { in: ['ACTIVE', 'OVERDUE'] } } }),
    ]);

    if (transactions.length === 0 && setup.configuredIncome === 0 && savingsGoals.length === 0 && loans.length === 0) {
      return res.json({
        insights: [
          {
            id: "1",
            icon: "💡",
            title: "Start Logging",
            message: "Log your first transaction to receive personalized AI insights.",
            type: "info",
          },
        ],
      });
    }

    // Build context for the AI
    const expenses = transactions.filter((t) => ["EXPENSE", "BILL_PAYMENT", "DEBT_PAYMENT"].includes(t.type));
    const totalSpent = expenses.reduce((s, t) => s + money(t.amount), 0);
    const totalIncome = money(setup?.totalIncome);
    const safeToSpend = money(setup?.safeToSpend);

    // Category breakdown
    const catMap: Record<string, number> = {};
    expenses.forEach((t) => {
      const cat = t.category || "Others";
      catMap[cat] = (catMap[cat] || 0) + money(t.amount);
    });
    const topCategories = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cat, amt]) => `${cat}: ₱${amt.toLocaleString()}`)
      .join(", ");

    // Weekend vs weekday spending
    const weekendSpend = expenses
      .filter((t) => [0, 6].includes(new Date(t.date).getDay()))
      .reduce((s, t) => s + money(t.amount), 0);
    const weekdaySpend = totalSpent - weekendSpend;

    // Savings progress
    const totalSaved = savingsGoals.reduce((s, g) => s + money(g.currentAmount), 0);
    const totalTarget = savingsGoals.reduce((s, g) => s + money(g.targetAmount), 0);
    const savingsPct = totalTarget > 0 ? Math.round((totalSaved / totalTarget) * 100) : 0;

    const contextSummary = `
User Financial Summary:
- Total Income: ₱${totalIncome.toLocaleString()}
- Safe-to-Spend: ₱${safeToSpend.toLocaleString()}
- Total Spent (${expenses.length} transactions): ₱${totalSpent.toLocaleString()}
- Top categories: ${topCategories || "None"}
- Weekend spending: ₱${weekendSpend.toLocaleString()} vs Weekday: ₱${weekdaySpend.toLocaleString()}
- Savings: ₱${totalSaved.toLocaleString()} of ₱${totalTarget.toLocaleString()} target (${savingsPct}%)
- Active loans: ${loans.length}
`;

    // Try Gemini API
    const apiKey = process.env.GEMINI_API_KEY || "";
    let insightTexts: string[] = [];

    const subscription = await getSubscriptionSummary(userId);
    if (subscription.plan === 'PLUS' && apiKey && apiKey !== "dummy_gemini_api_key_here") {
      try {
        const cacheKey = `__DASHBOARD_INSIGHTS__:${new Date().toISOString().slice(0, 10)}:${createHash('sha256').update(contextSummary).digest('hex').slice(0, 16)}`;
        const cached = await prisma.aiSession.findFirst({ where: { userId, question: cacheKey, state: 'COMPLETED' }, orderBy: { createdAt: 'desc' } });
        if (cached) {
          const parsed = JSON.parse(cached.answer);
          if (Array.isArray(parsed)) insightTexts = parsed.slice(0, 3).map(String);
        }
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-3.6-flash" });

        const prompt = `You are CASHA-BA, a personal finance AI assistant for Filipino users.
Based on this financial summary, generate EXACTLY 3 short, specific, personalized insight messages.
Each insight must be 1-2 sentences max, actionable, and reference actual numbers from the data.
Output ONLY a JSON array of 3 strings, no markdown, no extra text.
Example format: ["Insight 1 text.", "Insight 2 text.", "Insight 3 text."]

Financial data:
${contextSummary}`;

        if (insightTexts.length > 0) throw new Error('CACHED_INSIGHTS_READY');
        const result = await model.generateContent(prompt);
        const responseText = result.response.text().trim();
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            insightTexts = parsed.slice(0, 3).map(String);
            await prisma.aiSession.create({ data: { userId, question: cacheKey, answer: JSON.stringify(insightTexts), model: process.env.GEMINI_MODEL || 'gemini-3.6-flash', promptTokens: 0, responseTokens: 0, totalTokens: 0, state: 'COMPLETED' } });
          }
        }
      } catch (err) {
        if (!(err instanceof Error && err.message === 'CACHED_INSIGHTS_READY')) console.warn("Gemini insights call failed, using heuristic fallback", err);
      }
    }

    // Heuristic fallback if AI failed or no key
    if (insightTexts.length === 0) {
      const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
      insightTexts = [
        topCat
          ? `Your biggest spending category is ${topCat[0]} at ₱${topCat[1].toLocaleString()} — ${Math.round((topCat[1] / (totalSpent || 1)) * 100)}% of your total expenses.`
          : "Start logging expenses to see category breakdowns.",
        savingsPct > 0
          ? `You've saved ₱${totalSaved.toLocaleString()} toward your goals — ${savingsPct}% of your total target. Keep it up!`
          : "Set a savings goal to start tracking your progress.",
        safeToSpend > 0
          ? `Your current Safe-to-Spend is ₱${safeToSpend.toLocaleString()}. Stay within this limit to protect your financial obligations.`
          : "Complete your income setup to see your real Safe-to-Spend amount.",
      ];
    }

    // Map insights to rich objects with icons and color types
    const iconMap = ["📊", "🎯", "💡", "⚠️"];
    const typeMap: ("info" | "success" | "warning" | "tip")[] = [
      "info",
      "success",
      "tip",
      "warning",
    ];

    const insights = insightTexts.map((msg, i) => ({
      id: String(i + 1),
      icon: iconMap[i] || "💡",
      title: ["Spending Pattern", "Savings Progress", "Safe-to-Spend", "Heads Up"][i] || "Insight",
      message: msg,
      type: typeMap[i] || "info",
    }));

    res.json({ insights });
  } catch (error) {
    console.error("getFinancialInsights error:", error);
    res.status(500).json({ message: "Error fetching financial insights" });
  }
};
