import type { FinancialPlan } from './financialPlanner';
import { normalizeChatQuestion } from './chatQuestion';
import { isPurchaseGoalImpact } from './planningInputs';

type Operation = FinancialPlan['operation'];
// These describe tools, not user answers. The same descriptions guide provider
// extraction and protect clear question intents from unrelated model routing.
export const PLANNING_OPERATIONS: Record<Operation, string> = {
  cash_available: 'Maximum discretionary cash, affordable price/budget or saving amount after protected money, essentials and commitments. No specific purchase deducted.',
  afford_purchase: 'Whether a specific purchase, expense, gift or lending amount fits accessible cash; show cash remaining after that purchase.',
  daily_limit: 'How long remaining cash lasts until payday, or the daily spending ceiling through a confirmed horizon.',
  runway: 'How long accessible savings cover essentials without income.',
  goal_timeline: 'How many contributions or how long to reach a goal at a stated/current saving rate, including a cheaper target.',
  goal_contribution: 'Required saving/extra income per contribution to reach a target within a deadline or stated number of periods; realism/on-track checks.',
  goal_change: 'Effect on recorded goals of a purchase, changed contributions, a bonus, skipped contributions or withdrawal. A purchase cost uses purchase, not delta or the target of an existing goal. Ask whether the purchase is funded by cash, goal_savings or planned_contributions; never invent funding or choose a goal. Extra income adds to the existing saving rate. Use delta for an increase by a stated amount; contribution is a separately stated base saving amount, never that increment.',
  goal_split: 'Allocate one contribution budget across multiple selected savings goals in priority order.',
  budget_review: 'Actual spending versus the current budget target; whether spending is on track, faster than planned or realistic.',
  budget_allocate: 'Plan income among essentials, commitments and savings; assess ongoing subscription/installment costs against monthly income.',
  income_change: 'Effect of a hypothetical increase/decrease in income or essential expenses on the monthly plan.',
  income_history: 'Irregular income and completed-month average/lowest income scenarios.',
  category_spending: 'Recorded spending, largest purchases/categories, causes of money running out and categories to adjust; filter requested dates/category.',
  spending_compare: 'Recorded spending/category changes versus equivalent dates in a previous month, not spending versus budget.',
  spending_cut: 'Savings from a specified percentage cut, avoided purchases or replacement costs and actual occurrence dates.',
  history_peak: 'Highest recorded spending month and its largest category.',
  period_forecast: 'Estimate future end-of-period balance or savings at the observed pace; not a query about past spending.',
  debt_payoff: 'Debt payoff, interest/fee costs, prioritization or a new-loan scenario with confirmed repayment terms.',
  debt_compare: 'Compare repayment timelines after an extra payment.',
  debt_totals: 'Recorded unpaid borrowed debt or money lent but not yet repaid.',
  debt_budget: 'Monthly income remaining after scheduled debt payments.',
  bill_reserve: 'Bills/recurring commitments due through the requested horizon and required reserves; not purchase affordability.',
  bill_forecast: 'Future scheduled bill commitments through a stated date.',
  bill_cost: 'Recurring subscription/bill costs, cancellation savings and yearly equivalents.',
  emergency_cover: 'Essential-expense coverage target for an emergency fund or time away from work.',
  school_budget: 'Allowance or student income after actual attendance days, food, transport and other school costs.',
  cost_plan: 'Use the full supplied move-in total for rental savings questions, without requiring an alternative. Compare costs of actual alternatives over the same period. For a job or business budget change, include both current and new take-home income and full costs; cheaper transport alone does not establish affordability. Keep one-time and recurring costs separate.',
  missing_info: 'Identify missing inputs for a goal plan without assuming amounts, dates or frequencies.',
};

const rules: Array<[Operation, RegExp]> = [
  ['missing_info', /what information|still need|missing information/],
  ['debt_totals', /still owe|borrowed money.*owe|lent.*(?:not|hasn.t).*repaid|money.*lent.*repaid/],
  ['debt_budget', /remain.*income.*debt|income after.*debt/],
  ['debt_compare', /(?:extra|earlier).*(?:finish|pay|loan|debt)|(?:pay|loan|debt).*extra/],
  ['cost_plan', /cash or.*installment|deposits|basic furniture|closer to work|small business|lower.paying|how much.*(?:save|set aside).*mov(?:e|ing)|move.in.*cost/],
  ['debt_payoff', /pay off|payoff|clear my loan|finish my loan|total cost.*installment|interest rate|which debt|another loan/],
  ['daily_limit', /(?:balance|money|cash).*last.*(?:payday|next income)|payday.*delay|allowance.*(?:late|arrives late)|daily.*(?:limit|spending)|limit.*daily|miss.*weeks.*work/],
  ['runway', /how long.*(?:savings last|money last)|lose my income/],
  ['income_history', /income changes (?:every|each)|average income|lowest.income|irregular income|variable income/],
  ['income_change', /(?:income|salary).*(?:drops|increases|decreases)|less income|without income|(?:essential|electricity|bill|expense).*(?:increased|increases|rises|rise|by \d+%)/],
  ['emergency_cover', /emergency fund.*cover|how much.*(?:emergency.*keep|keep.*(?:unexpected|emergency)|before taking.*off work)/],
  ['bill_cost', /subscriptions.*cost|cancel.*subscriptions|recurring expenses.*reduce/],
  ['goal_split', /split.*sav|divide (?:my |the )?savings|both.*(?:laptop|phone|vacation)|vacation and.*phone|which.*goals.*finish/],
  ['goal_change', /skip saving|withdraw|increase.*saving|save.*more|bonus.*(?:closer|debt|goal)|extra.*income.*goal|(?:earn|receive).*extra.*goal|affect.*(?:other )?savings goals|emergency.*goals.*delay/],
  ['spending_cut', /cut.*half|stop buying|bringing lunch|packed meals|reduce.*free up/],
  ['period_forecast', /(?:balance|save|saving).*(?:end of (?:the|this) month|end of the year)/],
  ['cash_available', /how much.*save.*(?:after.*bills|without|safely|can afford)|maximum.*sav(?:e|ing)/],
  ['goal_timeline', /\bcheaper\b.*(?:earlier|reach).*\b(?:goal|saving)/],
  ['goal_contribution', /how much.*(?:save|set aside).*(?:monthly|weekly|payday|month|year|enrollment|wedding)|how much.*need.*save|extra income.*(?:afford|purchase|within)|reach.*(?:six months|two years|one year)|buy.*within.*year|on track|finish.*earlier|savings target.*realistic|emergency money.*(?:build|months)|saving for bills.*due/],
  ['goal_timeline', /how long|how many(?: (?:daily|weekly|monthly|payday))? (?:savings? )?(?:contributions?|deposits?)\b|when.*(?:reach|finish)|current pace.*goal|goal.*current pace|tigom|kailan|save.*every day|save for.*(?:laptop|phone)|saving.*\d|cheaper.*(?:reach|goal)|save.*laptop.*allowance/],
  ['history_peak', /highest spending/],
  ['spending_compare', /spen[dt].*(?:more|less).*last month|category increased|category.*increase.*most/],
  ['category_spending', /where.*money go|spent.*since|spent.*year|which purchases|food delivery|commuting.*cost|practical change|money.*run.*out|budget categor|past spending|subscriptions.*increased|small daily purchases|expenses.*(?:temporarily reduce|reduce.*emergency)/],
  ['budget_review', /budget.*realistic|spending faster.*plan|review.*budget|spending.*(?:against|versus).*budget/],
  ['budget_allocate', /divide.*income|low.income.*month|allocate.*payment|budget.*(?:income|paycheck|gifts)|basic needs|essential expenses|income goes|next paycheck|prioritize.*cannot pay|income.*(?:save money|support)|save money.*monthly income|repay.*debt.*emergency|monthly.*(?:subscription|installment)|(?:subscription|installment).*monthly/],
  ['bill_reserve', /(?:all )?bills.*due|which bills|reserve.*(?:rent|electricity|bills)|committed.*recurring|set aside.*(?:bills|rent)|bills.*not.*paid/],
  ['school_budget', /allowance|school days|baon|ojt|exam week|school expenses/],
  ['cash_available', /maximum amount.*spend|how much.*(?:safely spend|can.*spend|can.*save|available|household|keep untouched)|what.*budget.*afford|money.*available|enough accessible|repays.*late|without.*daily budget.*tight/],
  ['afford_purchase', /afford|can i.*(?:buy|spend|eat|lend|cover|handle|support)|enough.*(?:bill|money)|purchase today|purchase.*today|if i (?:spend|buy|lend)|should i buy/],
];

export function planningQuestion(message: string) {
  message = normalizeChatQuestion(message);
  // Structured scenario inputs are values, not intent instructions.
  return message.split(/(?:^|\s)(?:Explicit hypothetical scenario details[^\n:]*|Scenario|Planning inputs|Details)\s*:\s*(?=\{)|\n```(?:json)?\s*\n/i)[0].trim();
}
export function clearPlanningIntent(message: string): Operation | null {
  const question = planningQuestion(message).normalize('NFKC').toLowerCase();
  if (isPurchaseGoalImpact(question)) return 'goal_change';
  return rules.find(([, pattern]) => pattern.test(question))?.[0] ?? null;
}
