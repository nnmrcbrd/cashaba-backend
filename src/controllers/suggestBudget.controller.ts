import { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { consumeUsage, refundUsage, getSubscriptionSummary } from '@/services/subscription';
import { budgetInputSchema, buildBudgetSuggestion, validateBudgetProposal } from '@/utils/budgetSuggestion';
import { safeQualitativeReply } from '@/utils/aiSafety';

export const suggestBudget = async (req: Request, res: Response) => {
  const input = budgetInputSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ message: 'Provide a positive income with at most two decimal places and a weekly or monthly period' });
  const { income, period } = input.data;
  const defaults = buildBudgetSuggestion(income, period);
  let usageId: string | null = null;
  try {
    const subscription = await getSubscriptionSummary(req.user!.userId);
    const apiKey = process.env.GEMINI_API_KEY;
    if (subscription.plan === 'PLUS' && apiKey && apiKey !== 'dummy_gemini_api_key_here') {
      try {
        usageId = (await consumeUsage(req.user!.userId, 'aiRequests')).id;
        const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-3.6-flash' });
        const result = await model.generateContent('Suggest plain, generic Filipino budgeting labels for this starting plan. Return ONLY JSON with exactly the same fields and counts. Preserve every monetary amount. Do not include investment recommendations or guarantees. The plan is not a statement of actual obligations.\n' + JSON.stringify(defaults));
        const match = result.response.text().match(/\{[\s\S]*\}/);
        const proposal = match ? validateBudgetProposal(JSON.parse(match[0]), income, period) : null;
        if (proposal && proposal.fixedExpenses.length === 4 && proposal.savingsGoals.length === 2 &&
            [...proposal.fixedExpenses, ...proposal.savingsGoals].every(item => safeQualitativeReply(item.name))) {
          // AI labels the starting plan; money and the narrative stay deterministic.
          return res.json({ ...defaults,
            fixedExpenses: defaults.fixedExpenses.map((item, index) => ({ ...item, name: proposal.fixedExpenses[index].name })),
            savingsGoals: defaults.savingsGoals.map((item, index) => ({ ...item, name: proposal.savingsGoals[index].name })),
          });
        }
        throw new Error('INVALID_BUDGET_PROPOSAL');
      } catch {
        if (usageId) { await refundUsage(req.user!.userId, 'aiRequests', usageId); usageId = null; }
      }
    }
    return res.json(defaults);
  } catch {
    return res.status(503).json({ message: 'Budget suggestions are temporarily unavailable' });
  }
};
