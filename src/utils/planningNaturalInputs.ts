import { planSchema, type FinancialPlan } from './financialPlanner';
import type { AdviceFacts } from './personalFinanceAdvice';
import { businessDateLabel } from './calendar';
import { addMonths } from './planningCalculators';
import { mentionsGoal } from './planningInputs';
import { planningQuestion } from './planningIntent';

const amount = '(?:₱|php\\s*)?((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)(?![\\p{L}\\p{N}]|[.,]\\d)';
const countWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d+';
const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const count = (text?: string) => text == null ? undefined : /^\d+$/.test(text) ? Number(text) : words.indexOf(text.toLowerCase());
const dayOffset = (date: string, days: number) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);

// Interpret current-user wording only. This supplies financial roles, never
// amounts from a guide/model or assumed zero expenses. Explicit typed details
// are applied afterward so a user can define the scenario precisely.
export function naturalPlanningInputs(message: string, facts: AdviceFacts, plan: FinancialPlan): Partial<FinancialPlan> {
  message = planningQuestion(message);
  const inputs: Partial<FinancialPlan> = {};
  const today = facts.planning ? businessDateLabel(new Date(facts.planning.asOf)) : businessDateLabel();
  const value = (pattern: string) => {
    const match = message.match(new RegExp(pattern, 'iu'));
    const parsed = match ? planSchema.shape.target.safeParse(Number(match[1].replaceAll(',', ''))) : null;
    return parsed?.success ? parsed.data : undefined;
  };
  if (plan.operation.startsWith('goal_')) {
    if (/\b(?:my|current|recorded) (?:savings? )?(?:goals?|target)\b/i.test(message)) inputs.usesRecordedGoal = true;
    if (plan.operation === 'goal_split' && /which.*(?:savings )?goals.*finish.*year/i.test(message)) {
      inputs.goalMode = 'recorded_completion'; inputs.frequency = 'monthly'; inputs.until = today.slice(0,4) + '-12-31';
    }
    if (/printing|school supplies|enrollment/i.test(message)) inputs.goalPurpose = 'school';
    else if (/sav.*bills/i.test(message)) inputs.goalPurpose = 'bills';
    else if (/this purchase|christmas|wedding|annual payment|appliance|trip/i.test(message)) inputs.goalPurpose = 'cost';
    if (plan.operation === 'goal_timeline' && /\bcheaper\b/i.test(message)) {
      inputs.goalMode = 'cheaper_target';
      inputs.target = value(`\\bcheaper\\b[^.!?\\n]{0,60}?\\b(?:for|price|cost|at)\\s*${amount}`);
    }
    if (plan.goalMode === 'cheaper_target') inputs.alternativeCost = value(`\\boriginal (?:target|price|target price)\\s*(?:is|:|=)?\\s*${amount}`);
    if (plan.operation === 'goal_contribution') {
      const earlier = count(message.match(new RegExp(`\\b(${countWords}) months? earlier\\b`, 'i'))?.[1]);
      if (earlier && earlier <= 1200) inputs.finishMonthsEarlier = earlier;
      if (/how much.*(?:emergency|savings?|money).*\bbuild\b/i.test(message)) {
        inputs.goalMode = 'build_savings';
        const months = count(message.match(new RegExp(`\\b(?:over|in|within) (?:the )?(?:next )?(${countWords}) months?\\b`, 'i'))?.[1]);
        if (months && months <= 1200) inputs.periods = months;
      }
    }
    if (plan.operation === 'goal_change' && /\bskip saving (?:this|one) month\b/i.test(message)
      && (!plan.frequency || plan.frequency === 'monthly')) inputs.skipPeriods = 1;
  }
  if (plan.operation === 'daily_limit' && /payday.*delayed? by (?:one|a|1) week/i.test(message)
    && facts.planning?.nextPayday) inputs.nextPayday = dayOffset(facts.planning.nextPayday, 7);
  if (plan.operation === 'daily_limit' && /this month/i.test(message)) inputs.until = addMonths(today.slice(0,7) + '-01', 1);
  if (plan.operation === 'bill_reserve' && /this week/i.test(message)) inputs.until = dayOffset(today, 7 - (new Date(today).getUTCDay() + 6) % 7);
  if (plan.operation === 'income_change' && /(?:less income|income (?:drops|decreases)|salary (?:drops|decreases))/i.test(message)) inputs.needsIncomeChange = true;
  if (plan.operation === 'category_spending' || plan.operation === 'spending_cut' || plan.operation === 'spending_compare') {
    const categories = [...new Set(facts.planning?.spending.filter(row => ['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'].includes(row.type)).map(row => row.category) ?? [])].filter(category => mentionsGoal(message, category));
    if (categories.length === 1) inputs.category = categories[0];
    else if (/\bgrocer(?:y|ies)\b/i.test(message)) inputs.category = 'Groceries';
    else if (/\bfood delivery\b/i.test(message)) inputs.category = 'Food Delivery';
    else if (/commuting to school/i.test(message)) inputs.category = 'School commuting';
    if (/subscriptions?.*increased/i.test(message)) { inputs.reviewKind = 'subscription_change'; delete inputs.category; }
    if (/one practical change/i.test(message)) inputs.reviewKind = 'practical_change';
    if (/small daily purchases/i.test(message)) inputs.reviewKind = 'small_purchases';
    if (/since my last payday/i.test(message)) { inputs.sincePayday = true; if (facts.planning?.lastPayday) inputs.from = facts.planning.lastPayday; }
    if (plan.operation === 'spending_cut') {
      if (/\bin half\b/i.test(message)) inputs.percentCut = 50;
      const cut = Number(message.match(/\b(?:cut|reduce)\b.*?\b(\d+)\s*%/i)?.[1]);
      if (Number.isInteger(cut) && cut >= 0 && cut <= 100) inputs.percentCut = cut;
      inputs.desiredSaving = value(`\\bfree up\\s+${amount}`);
      if (/\bstop buying\b/i.test(message)) {
        inputs.unitCost = value(`\\bstop buying\\s+(?:(?:a|an)\\s+)?${amount}`);
        inputs.replacementCost = 0; // Explicit cessation, not a free replacement meal.
        if (/every weekday/i.test(message)) inputs.weekdays = [1, 2, 3, 4, 5];
        if (/\bin (?:a|one|1) year\b/i.test(message)) { inputs.from = today; inputs.until = dayOffset(addMonths(today, 12), -1); }
      }
      const days = count(message.match(new RegExp(`\\b(${countWords}) days? a week\\b`, 'i'))?.[1]);
      if (days && days <= 7) inputs.daysPerWeek = days;
      const meal = value(`\\b(?:current (?:meal|lunch) cost|meal cost|lunch cost)\\s*(?:is|:|=)?\\s*${amount}`);
      const replacement = value(`\\b(?:packed meal cost|replacement cost)\\s*(?:is|:|=)?\\s*${amount}`);
      if (meal != null) inputs.unitCost = meal;
      if (replacement != null) inputs.replacementCost = replacement;
    }
  }
  if (plan.operation === 'bill_cost') {
    if (/\bsubscriptions?\b/i.test(message)) inputs.subscriptionSelection = true;
    const named = (facts.planning?.recurringObligations ?? facts.planning?.obligations ?? []).filter(row => mentionsGoal(message, row.name));
    if (named.length) inputs.billNames = named.map(row => row.name);
  }
  if (plan.operation === 'school_budget') {
    const allowance = value(`\\ballowance\\s*(?:is|of|:|=)?\\s*${amount}`)
      ?? value(`${amount}\\s+(?:(?:weekly|monthly|daily)\\s+)?allowance\\b`);
    const food = value(`\\bspend\\s+${amount}\\s+(?:on|for) food\\b`);
    if (allowance != null) inputs.income = allowance;
    if (food != null) inputs.dailyFood = food;
    const days = count(message.match(new RegExp(`\\b(${countWords}) (?:actual )?school days?\\b`, 'i'))?.[1]);
    if (days && days <= 366) inputs.schoolDays = days;
  }
  if (plan.operation === 'debt_payoff' && /\bmonthly\b/i.test(message) && /within (?:one|a|1) year/i.test(message)) inputs.periods = 12;
  if (plan.operation === 'debt_payoff' && /which debt.*prioriti/i.test(message)) inputs.debtMode = 'priority';
  if (plan.operation === 'debt_payoff' && /another loan/i.test(message)) inputs.debtMode = 'new_loan';
  return Object.fromEntries(Object.entries(inputs).filter(([, item]) => item != null));
}
