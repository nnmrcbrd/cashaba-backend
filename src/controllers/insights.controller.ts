import { Request, Response } from "express";
import { createHash } from 'node:crypto';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";
import { money } from "@/utils/money";
import { calculateSafeToSpend } from '@/utils/safeToSpend';
import { getSubscriptionSummary, consumeUsage, refundUsage } from '@/services/subscription';
import { z } from 'zod';
import { businessDate } from '@/utils/calendar';

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

    // Weekend vs weekday spending
    const weekendSpend = expenses
      .filter((t) => [0, 6].includes(businessDate(t.date).getUTCDay()))
      .reduce((s, t) => s + money(t.amount), 0);
    const weekdaySpend = totalSpent - weekendSpend;

    // Savings progress
    const totalSaved = savingsGoals.reduce((s, g) => s + money(g.currentAmount), 0);
    const totalTarget = savingsGoals.reduce((s, g) => s + money(g.targetAmount), 0);
    const savingsPct = totalTarget > 0 ? Math.round((totalSaved / totalTarget) * 100) : 0;

    // Model selects priorities from verified facts; it cannot invent card text.
    const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
    const candidates = [
      { id: 'spending', text: topCat ? 'Your biggest spending category is ' + topCat[0] + ' at ₱' + topCat[1].toLocaleString() + ' — ' + Math.round(topCat[1] / (totalSpent || 1) * 100) + '% of your total expenses.' : 'Start logging expenses to see category breakdowns.' },
      { id: 'savings', text: totalTarget > 0 ? "You've saved ₱" + totalSaved.toLocaleString() + ' toward your goals — ' + savingsPct + '% of your total target.' : 'Set a savings goal to start tracking your progress.' },
      { id: 'safe-to-spend', text: safeToSpend > 0 ? 'Your current Safe-to-Spend is ₱' + safeToSpend.toLocaleString() + '. Stay within this limit to protect your financial obligations.' : setup.rawSafeToSpend < 0 ? 'Your current commitments exceed recorded income by ₱' + Math.abs(setup.rawSafeToSpend).toLocaleString() + '. Safe-to-Spend is zero.' : 'Safe-to-Spend is zero. Record received income and review your bills, savings and debt commitments; expected pay is not received funds.' },
    ];
    const selectionSchema = z.array(z.enum(['spending', 'savings', 'safe-to-spend'])).length(3)
      .refine(ids => new Set(ids).size === 3);
    let order = candidates.map(item => item.id);
    const safeFacts = { income: totalIncome, spending: totalSpent, safeToSpend, shortfall: Math.max(0, -setup.rawSafeToSpend), savingsPct, weekendSpend, weekdaySpend, activeLoans: loans.length };
    const apiKey = process.env.GEMINI_API_KEY;
    const subscription = await getSubscriptionSummary(userId);
    if (subscription.plan !== 'FREE' && apiKey && apiKey !== 'dummy_gemini_api_key_here') {
      let usageId: string | null = null;
      try {
        const cacheKey = '__DASHBOARD_INSIGHTS__:v2:' + createHash('sha256').update(JSON.stringify(safeFacts)).digest('hex').slice(0, 24);
        const cached = await prisma.aiSession.findFirst({ where: { userId, question: cacheKey, state: 'COMPLETED' }, orderBy: { createdAt: 'desc' } });
        const prior = cached ? selectionSchema.safeParse(JSON.parse(cached.answer)) : null;
        if (prior?.success) order = prior.data;
        else {
          usageId = (await consumeUsage(userId, 'aiRequests')).id;
          const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
          const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
          const result = await model.generateContent('Rank these three budgeting topics by urgency using only the facts. Return ONLY a JSON array containing each ID exactly once: spending, savings, safe-to-spend. Do not provide narrative or recommendations. Prioritize shortfalls. Policy: insight-selection-v2.\n' + JSON.stringify(safeFacts));
          const match = result.response.text().match(/\[[\s\S]*\]/);
          const selected = selectionSchema.safeParse(match ? JSON.parse(match[0]) : null);
          if (!selected.success) throw new Error('INVALID_INSIGHT_SELECTION');
          order = selected.data;
          const usage = result.response.usageMetadata;
          await prisma.aiSession.create({ data: { userId, question: cacheKey, answer: JSON.stringify(order), model: modelName, promptTokens: usage?.promptTokenCount ?? 0, responseTokens: usage?.candidatesTokenCount ?? 0, totalTokens: usage?.totalTokenCount ?? 0, state: 'COMPLETED' } });
        }
      } catch {
        if (usageId) { try { await refundUsage(userId, 'aiRequests', usageId); } catch { console.warn('Failed insight quota refund'); } }
      }
    }
    const insightTexts = order.map(id => candidates.find(candidate => candidate.id === id)!.text);

    // Map insights to rich objects with icons and color types
    const metadata: Record<string, { icon: string; title: string; type: 'info' | 'success' | 'warning' | 'tip' }> = {
      spending: { icon: '📊', title: 'Spending Pattern', type: 'info' },
      savings: { icon: '🎯', title: 'Savings Progress', type: 'success' },
      'safe-to-spend': { icon: setup.rawSafeToSpend < 0 ? '⚠️' : '💡', title: 'Safe-to-Spend', type: setup.rawSafeToSpend < 0 ? 'warning' : 'tip' },
    };

    const insights = insightTexts.map((msg, i) => ({
      id: String(i + 1),
      ...metadata[order[i]],
      message: msg,
    }));

    res.json({ insights });
  } catch (error) {
    console.error("getFinancialInsights error:", error);
    res.status(500).json({ message: "Error fetching financial insights" });
  }
};
