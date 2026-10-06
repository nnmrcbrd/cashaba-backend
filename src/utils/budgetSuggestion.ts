import { z } from 'zod';
import { positiveMoney } from '@/schema/movement';
import { WEEKS_PER_MONTH } from './money';
export { WEEKS_PER_MONTH } from './money';
const MAX_MONEY = 999_999_999_999.99;
export const budgetInputSchema = z.object({ income: positiveMoney, period: z.enum(['weekly', 'monthly']) })
  .refine(({ income, period }) => income * (period === 'weekly' ? WEEKS_PER_MONTH : 1) * 6 <= MAX_MONEY,
    'Income is too large for the suggested savings targets');
const centAmount = z.number().finite().min(0).max(MAX_MONEY)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.001);
export const budgetProposalSchema = z.object({
  fixedExpenses: z.array(z.object({ name: z.string().trim().min(1).max(120), amount: centAmount }).strict()).min(1).max(4),
  savingsGoals: z.array(z.object({ name: z.string().trim().min(1).max(120), targetAmount: centAmount,
    monthlyAllocation: centAmount }).strict()).min(1).max(2),
  weeklyAllowance: centAmount,
  summary: z.string().trim().min(1).max(1000),
}).strict();
export function buildBudgetSuggestion(income: number, period: 'weekly' | 'monthly') {
  const monthlyCents = Math.round(income * 100 * (period === 'weekly' ? WEEKS_PER_MONTH : 1));
  const needs = Math.floor(monthlyCents * 0.5), savings = Math.floor(monthlyCents * 0.2);
  const rent = Math.floor(needs * 0.5), utilities = Math.floor(needs * 0.16), groceries = Math.floor(needs * 0.2);
  const emergency = Math.floor(savings * 0.75);
  const weekly = Math.floor((monthlyCents - needs - savings) / WEEKS_PER_MONTH);
  return {
    fixedExpenses: [
      { name: 'Rent / Housing', amount: rent / 100 },
      { name: 'Utilities (Meralco, Water, Internet)', amount: utilities / 100 },
      { name: 'Groceries', amount: groceries / 100 },
      { name: 'Transportation', amount: (needs - rent - utilities - groceries) / 100 },
    ],
    savingsGoals: [
      { name: 'Emergency Fund', targetAmount: monthlyCents * 6 / 100, monthlyAllocation: emergency / 100 },
      { name: 'Personal Savings', targetAmount: monthlyCents * 3 / 100, monthlyAllocation: (savings - emergency) / 100 },
    ],
    weeklyAllowance: weekly / 100,
    summary: 'A starting plan: 50% for needs, 20% for savings, and up to 30% for wants. Weekly amounts use 52 weeks / 12 months. Review your actual bills and debt payments before applying it.',
  };
}
export function validateBudgetProposal(value: unknown, income: number, period: 'weekly' | 'monthly') {
  const parsed = budgetProposalSchema.safeParse(value);
  if (!parsed.success) return null;
  const monthlyCents = Math.round(income * 100 * (period === 'weekly' ? WEEKS_PER_MONTH : 1));
  const allocated = parsed.data.fixedExpenses.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) +
    parsed.data.savingsGoals.reduce((sum, item) => sum + Math.round(item.monthlyAllocation * 100), 0) +
    Math.round(parsed.data.weeklyAllowance * 100) * WEEKS_PER_MONTH;
  if (allocated > monthlyCents + 0.0001 || parsed.data.savingsGoals.some(goal => goal.monthlyAllocation > goal.targetAmount)) return null;
  return parsed.data;
}
