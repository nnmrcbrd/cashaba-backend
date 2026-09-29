import { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { consumeUsage, getSubscriptionSummary } from '@/services/subscription';

/**
 * POST /api/ai/suggest-budget
 * Takes the user's income and returns an AI-suggested budget allocation
 * based on the 50/30/20 rule adapted for Filipino spending patterns.
 * No DB writes — pure computation.
 */
export const suggestBudget = async (req: Request, res: Response) => {
  try {
    const { income, period } = req.body;

    if (!income || Number(income) <= 0) {
      return res.status(400).json({ message: "Income amount required" });
    }

    const monthlyIncome = period === "weekly" ? Number(income) * 4 : Number(income);

    // Heuristic default (50/30/20 rule adapted for PH)
    const defaults = {
      fixedExpenses: [
        { name: "Rent / Housing", amount: Math.round(monthlyIncome * 0.25) },
        { name: "Utilities (Meralco, Water, Internet)", amount: Math.round(monthlyIncome * 0.08) },
        { name: "Groceries", amount: Math.round(monthlyIncome * 0.10) },
        { name: "Transportation", amount: Math.round(monthlyIncome * 0.07) },
      ],
      savingsGoals: [
        { name: "Emergency Fund", targetAmount: Math.round(monthlyIncome * 6), monthlyAllocation: Math.round(monthlyIncome * 0.15) },
        { name: "Personal Savings", targetAmount: Math.round(monthlyIncome * 3), monthlyAllocation: Math.round(monthlyIncome * 0.05) },
      ],
      weeklyAllowance: Math.round((monthlyIncome * 0.30) / 4),
      summary: `Based on the 50/30/20 rule: 50% for needs (₱${Math.round(monthlyIncome * 0.50).toLocaleString()}), 30% for wants (₱${Math.round(monthlyIncome * 0.30).toLocaleString()}), 20% for savings (₱${Math.round(monthlyIncome * 0.20).toLocaleString()}).`,
    };

    // Try to get AI-enhanced suggestions
    const apiKey = process.env.GEMINI_API_KEY || "";
    const subscription = await getSubscriptionSummary(req.user!.userId);
    if (subscription.plan === 'PLUS' && apiKey && apiKey !== "dummy_gemini_api_key_here") {
      try {
        await consumeUsage(req.user!.userId, 'aiRequests');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-3.6-flash" });

        const prompt = `You are a Filipino personal finance advisor.
The user earns ₱${monthlyIncome.toLocaleString()} per month.
Apply the 50/30/20 rule adapted for Filipino living costs.
Output ONLY a JSON object with this exact structure (no markdown):
{
  "fixedExpenses": [{"name": string, "amount": number}],
  "savingsGoals": [{"name": string, "targetAmount": number, "monthlyAllocation": number}],
  "weeklyAllowance": number,
  "summary": string
}
Use realistic Philippine costs. Maximum 4 fixed expenses, 2 savings goals.`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text().trim();
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return res.json(parsed);
        }
      } catch (err) {
        console.warn("Gemini suggest-budget failed, using heuristic", err);
      }
    }

    return res.json(defaults);
  } catch (error) {
    console.error("suggestBudget error:", error);
    res.status(500).json({ message: "Error generating budget suggestion" });
  }
};
