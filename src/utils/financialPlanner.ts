import { z } from 'zod';
import type { AdviceFacts } from './personalFinanceAdvice';
import { businessDateLabel } from './calendar';
import { scheduledReserve } from './safeToSpend';
import { addMonths, calendarDay, cashWindow, cents, contributionDates, daysBetween, debtPayoff, goalTimeline, peso, pesos, requiredContribution, scheduleSchema } from './planningCalculators';

export const OPERATIONS = ['cash_available', 'afford_purchase', 'daily_limit', 'runway', 'goal_timeline', 'goal_contribution', 'goal_change', 'goal_split', 'budget_review', 'budget_allocate', 'income_change', 'income_history', 'category_spending', 'spending_compare', 'spending_cut', 'history_peak', 'period_forecast', 'debt_payoff', 'debt_compare', 'debt_totals', 'debt_budget', 'bill_reserve', 'bill_forecast', 'bill_cost', 'emergency_cover', 'school_budget', 'cost_plan', 'missing_info'] as const;
export const planSchema = z.object({
  operation: z.enum(OPERATIONS), language: z.enum(['en', 'tl', 'ceb']).default('en'),
  goalNames: z.array(z.string().min(1).max(100)).max(4).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length, 'Choose each goal once').optional(), category: z.string().min(1).max(80).optional(),
  target: peso.optional(), saved: peso.optional(), contribution: peso.optional(), delta: peso.optional(), withdrawal: peso.optional(),
  purchase: peso.optional(), income: peso.optional(), incomeDelta: z.number().finite().min(-1e9).max(1e9).optional(),
  incomePercent: z.number().min(-100).max(1000).optional(), essentialDaily: peso.optional(), protectedCash: peso.optional(),
  expenseDelta: peso.optional(), expensePercent: z.number().min(-100).max(1000).optional(),
  newSaving: peso.optional(), bonus: peso.optional(), bonusToDebt: peso.optional(),
  from: calendarDay.optional(), until: calendarDay.optional(), nextPayday: calendarDay.optional(), lastPayday: calendarDay.optional(),
  schedule: scheduleSchema.optional(), frequency: z.enum(['daily', 'weekly', 'monthly', 'payday']).optional(),
  periods: z.number().int().positive().max(3660).optional(), skipPeriods: z.number().int().min(0).max(1200).optional(),
  payment: peso.optional(), interestType: z.enum(['interest_free', 'flat', 'reducing']).optional(),
  rateBpsPerPeriod: z.number().int().min(0).max(100000).optional(), feePerPeriod: peso.optional(),
  schoolDays: z.number().int().min(0).max(366).optional(), dailyFood: peso.optional(), dailyTransport: peso.optional(), otherCosts: peso.optional(),
  percentCut: z.number().int().min(0).max(100).optional(), unitCost: peso.optional(), replacementCost: peso.optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  alternativeCost: peso.optional(), lent: z.boolean().optional(), emergencyMonths: z.number().int().min(1).max(24).optional(),
  billNames: z.array(z.string().min(1).max(100)).max(10).optional(), forecastKind: z.enum(['balance', 'savings']).optional(),
}).strict();
export type FinancialPlan = z.infer<typeof planSchema>;
export type PlanningResult = { operation: FinancialPlan['operation']; tools: string[]; values: Record<string, number | string | boolean | null>;
  missing: string[]; assumptions: string[]; content: string;
  sections?: { known: string; answer: string; records: string; question: string; qualifications: string } };
export const planningContextSchema = z.object({ kind: z.literal('FINANCIAL_PLAN_V1'), owner: z.string(), updatedAt: z.string().datetime(), plan: planSchema }).strict();
export type PlanningContext = z.infer<typeof planningContextSchema>;
export function readPlanningContext(value: unknown, owner: string, now = Date.now()) {
  const parsed = planningContextSchema.safeParse(value);
  if (!parsed.success || parsed.data.owner !== owner) return null;
  const age = now - Date.parse(parsed.data.updatedAt);
  return age >= -60000 && age <= 30 * 60000 ? parsed.data : null;
}
const php = (amount: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount);
const total = (amounts: number[]) => pesos(amounts.reduce((sum, value) => sum + cents(Math.max(0, value)), 0));
const spendingTypes = ['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'];
export function executeFinancialPlan(raw: unknown, facts: AdviceFacts): PlanningResult {
  const plan = planSchema.parse(raw), p = facts.planning, b = facts.breakdown;
  const today = p ? businessDateLabel(new Date(p.asOf)) : businessDateLabel();
  const result: PlanningResult = { operation: plan.operation, tools: ['summary'], values: {}, missing: [],
    assumptions: ['PHP; recorded amounts only. Missing entries are not known zero expenses.'], content: '' };
  const need = (key: string, question: string) => { if (!result.missing.includes(key)) { result.missing.push(key); questions.push(question); } };
  const questions: string[] = [];
  const goals = (plan.goalNames ?? []).flatMap(name => facts.goals.filter(goal => name.toLowerCase() === goal.name.toLowerCase()));
  const goal = goals.length === 1 ? goals[0] : undefined;
  if (plan.goalNames?.length && goals.length !== plan.goalNames.length && !plan.operation.startsWith('debt_')) need('goal_selection', 'Which recorded goal should I use?');
  const accessible = total(facts.accounts.filter(a => a.kind === 'ASSET' && ['CASH', 'BANK', 'EWALLET'].includes(a.accountType ?? '')).map(a => a.balance));
  const from = plan.from ?? today, until = plan.until ?? plan.nextPayday ?? p?.nextPayday ?? null;
  const plannedIncome = plan.income ?? (facts.incomePeriod === 'monthly' ? b.configuredIncome : null);
  function reserve(end: string) {
    result.tools.push('obligations', 'debts');
    if (!p) { need('due_records', 'Please record your outstanding bills and debts with due dates.'); return { bills: 0, debts: 0 }; }
    if (!p.recordsComplete && !p.obligations.length && !p.debts.length) need('due_records', 'Are there any unrecorded bills or debt payments due? No outstanding commitments are recorded.');
    const stop = new Date(end + 'T00:00:00+08:00');
    const bills = total(p.obligations.map(item => {
      if (!item.due) need('bill_due_dates', 'When are your undated bills due?');
      return scheduledReserve({ amount: item.amount, paid: item.paid, due: item.due ? new Date(item.due) : null, anchor: item.anchor ? new Date(item.anchor) : null, frequency: item.frequency, end: stop });
    }));
    const debts = total(p.debts.filter(item => item.type === 'BORROWED').map(item => scheduledReserve({ amount: item.payment || item.remaining, paid: item.paid, due: new Date(item.due), anchor: item.anchor ? new Date(item.anchor) : null, frequency: item.frequency, end: stop, remaining: item.remaining })));
    return { bills, debts };
  }
  function available(purchase = plan.purchase ?? 0) {
    result.tools.push('accounts', 'income', 'what_if');
    if (!facts.accounts.some(a => a.kind === 'ASSET' && ['CASH', 'BANK', 'EWALLET'].includes(a.accountType ?? ''))) need('accessible_accounts', 'Which Cash, bank or e-wallet balances are accessible?');
    if (facts.accounts.some(a => a.kind === 'ASSET' && a.balance < 0)) need('overdraft_terms', 'An account is overdrawn. What repayment or fees are due before payday, and are they already in your recorded debts?');
    if (!until) need('next_payday', 'When is your next confirmed payday?');
    if (until && until <= today) need('future_payday', 'What is your next future confirmed payday?');
    const daily = plan.essentialDaily ?? p?.essentialDaily;
    const protectedCash = plan.protectedCash ?? p?.protectedCash;
    if (daily == null) need('essential_daily', 'How much do you need per day for essential food, transport and other unrecorded needs?');
    if (protectedCash == null) need('protected_cash', 'How much of your accessible account money must stay untouched, excluding contributions already held in saved goals?');
    const reserves = until ? reserve(until) : { bills: 0, debts: 0 };
    const window = cashWindow({ accessible, protectedCash: protectedCash ?? 0, ...reserves,
      essentialDaily: daily ?? 0, days: until ? daysBetween(today, until) : 0, purchase, newSaving: plan.newSaving });
    Object.assign(result.values, { accessible, bills: reserves.bills, debts: reserves.debts, periodSafeToSpend: b.safeToSpend,
      ...(!result.missing.length ? window : {}) });
    result.assumptions.push('No future salary, loan collections, investments or credit limits treated as cash. Goal contributions already left source wallets.');
    return window;
  }
  const target = plan.target ?? goal?.target;
  const saved = plan.saved ?? goal?.saved;
  const contribution = plan.contribution ?? (plan.frequency == null || plan.frequency === 'monthly' ? goal?.monthlyAllocation : undefined);
  const frequency = plan.schedule?.frequency ?? plan.frequency ?? (goal && plan.contribution == null ? 'monthly' : undefined);
  const goalQuestion = ['goal_timeline', 'goal_change', 'goal_contribution', 'missing_info'].includes(plan.operation);
  function recordedSavingContext() {
    result.tools.push('income', 'spending', 'obligations', 'debts');
    Object.assign(result.values, { receivedIncome: b.actualIncome, recordedSpending: b.totalExpenses,
      reservedBills: b.totalFixed, reservedDebt: b.totalLoanRepayments, reservedSavings: b.totalSavings,
      periodSafeToSpend: b.safeToSpend });
    const period = facts.incomePeriod === 'weekly' ? 'week' : 'month';
    if (!p?.recordCount && b.actualIncome === 0 && b.totalExpenses === 0) {
      return `${b.configuredIncome ? `Your planned income is ${php(b.configuredIncome)} per ${period}. ` : ''}No received income or spending is recorded for this ${period}, so I cannot infer an affordable saving amount yet.`;
    }
    return `Your records for this ${period}${p ? ` as of ${today}` : ''}: ${php(b.actualIncome)} received, ${php(b.totalExpenses)} spent, ${php(b.totalFixed)} reserved for bills, ${php(b.totalLoanRepayments)} for debt and ${php(b.totalSavings)} for savings. Safe-to-Spend is ${php(b.safeToSpend)}. This is the current period's balance, not a confirmed recurring saving amount; unrecorded expenses may reduce it.`;
  }
  function goalInputs() {
    result.tools.push('goals', 'what_if');
    if (target != null) result.values.target = target;
    if (saved != null) result.values.saved = saved;
    if (contribution != null) result.values.contribution = contribution;
    if (target != null && saved != null) result.values.remaining = pesos(Math.max(0, cents(target) - cents(saved)));
    if (target == null) need('target_price', 'What is the target price in PHP, including the exact product variant? I have no verified current price source.');
    if (saved == null) need('saved_balance', 'How much is already saved specifically for this target?');
  }
  function historyRows(start = from, end = until ?? today) {
    result.tools.push('spending');
    if (!p || !p.recordCount) need('spending_history', 'Please record spending for the period you want to compare.');
    if (p && (start < p.historyStart || (p.firstRecord && start < p.firstRecord))) result.assumptions.push(`History may be incomplete before ${p.firstRecord ?? p.historyStart}.`);
    if (plan.category && p?.spending.length && !p.spending.some(row => row.category.toLowerCase() === plan.category!.toLowerCase())) need('category_classification', 'Which recorded category contains those purchases? No matching category is recorded.');
    return (p?.spending ?? []).filter(row => row.date >= start && row.date <= end && spendingTypes.includes(row.type)
      && (!plan.category || row.category.toLowerCase() === plan.category.toLowerCase()));
  }
  function essentialsThrough(months = 1) {
    const daily = plan.essentialDaily ?? p?.essentialDaily;
    if (daily == null) need('essential_daily', 'What is your essential daily spending, excluding bills and debt already recorded?');
    const end = addMonths(today, months), reserves = reserve(end);
    return total([reserves.bills, reserves.debts, pesos(cents(daily ?? 0) * daysBetween(today, end))]);
  }
  const monthlyEssentials = () => essentialsThrough(1);
  switch (plan.operation) {
    case 'cash_available': case 'afford_purchase': case 'daily_limit': {
      const cash = available();
      if (plan.operation === 'afford_purchase' && plan.purchase == null) need('purchase_price', 'What is the full purchase or trip cost?');
      if (!result.missing.length) {
        result.values.affordable = cash.afterPurchase >= 0;
        result.content = plan.operation === 'afford_purchase' ? `${cash.afterPurchase >= 0 ? 'Based on the supplied costs, this fits' : 'This would leave a shortfall'}: ${php(cash.available)} is available before the purchase; after ${php(plan.purchase!)} you would have ${php(cash.afterPurchase)}.`
          : plan.operation === 'daily_limit' ? `An additional discretionary limit is ${php(cash.dailyLimit ?? cash.available)} per day until ${until}, after essential spending and commitments.`
          : `${php(cash.available)} is available after ${php(cash.reserved)} of protected cash and upcoming needs${cash.shortfall ? `; the current shortfall is ${php(cash.shortfall)}` : ''}.`;
      }
      break;
    }
    case 'runway': {
      result.tools.push('accounts', 'obligations', 'what_if');
        const essential = monthlyEssentials();
      if (plan.saved == null) need('accessible_reserve', 'How much emergency reserve is accessible for living costs?');
      if (!result.missing.length) {
        result.values.monthlyEssentials = essential;
        let months = 0;
        if (essential > 0) while (months < 120 && cents(essentialsThrough(months + 1)) <= cents(plan.saved!)) months++;
        result.values.months = essential > 0 ? months : null;
        result.content = essential > 0 ? `Your ${php(plan.saved!)} reserve covers ${months}${months === 120 ? ' or more' : ''} complete month(s), counting actual calendar days and recorded bill/debt occurrences from ${today}. The first one-month period costs ${php(essential)}; no future income is assumed.` : 'No essential costs were supplied. A survival timeline cannot be estimated from zero recorded costs.';
      } break;
    }
    case 'goal_timeline': case 'goal_change': {
      goalInputs();
      if (contribution == null) need('contribution', 'How much can you afford to save per contribution, and how often?');
      if (plan.operation === 'goal_change' && plan.delta == null && plan.withdrawal == null && plan.skipPeriods == null && plan.incomeDelta == null && plan.bonus == null) need('change_amount', 'How much will your contribution or saved balance change?');
      if (!result.missing.length) {
        if (cents(plan.bonusToDebt ?? 0) > cents(plan.bonus ?? 0)) need('bonus_allocation', 'How much of the bonus will go to debt? It cannot exceed the bonus.');
        const adjustedSaved = Math.max(0, cents(saved!) - cents(plan.withdrawal ?? 0) + cents(plan.bonus ?? 0) - cents(plan.bonusToDebt ?? 0));
        const baseline = goalTimeline(target!, saved!, contribution!, plan.schedule);
        const amount = pesos(cents(contribution!) + cents(plan.delta ?? Math.max(0, plan.incomeDelta ?? 0)));
        const next = goalTimeline(target!, pesos(adjustedSaved), amount, plan.schedule);
        const skip = plan.skipPeriods ?? 0;
        const completion = goalTimeline(target!, pesos(adjustedSaved), amount, plan.schedule, skip).completionDate;
        Object.assign(result.values, next, { completionDate: completion, contribution: amount, baselinePeriods: baseline.periods,
          periodsSaved: baseline.periods != null && next.periods != null ? baseline.periods - next.periods - skip : null });
        if (plan.bonusToDebt) {
          const allSaved = goalTimeline(target!, pesos(cents(saved!) + cents(plan.bonus ?? 0)), amount);
          result.values.delayComparedWithSavingBonus = next.periods != null && allSaved.periods != null ? next.periods - allSaved.periods : null;
        }
        const count = (next.periods ?? 0) + skip;
        const years = frequency === 'monthly' && count >= 12 ? ` (about ${Math.floor(count / 12)} year(s)${count % 12 ? ` and ${count % 12} month(s)` : ''})` : '';
        result.content = next.periods === 0 ? 'The target is already fully funded from the savings you specified.'
          : next.periods == null ? `You still need ${php(next.remaining)}, but the contribution is zero. No completion date can be calculated.`
          : `You need ${php(next.remaining)} more. Saving ${php(amount)} ${frequency ? `per ${frequency} contribution` : 'each contribution'} takes ${count} ${frequency ? `${frequency} ` : ''}contribution(s)${years}${completion ? `; the last planned contribution is ${completion}` : `. An exact completion date needs ${frequency ? '' : 'a contribution frequency and '}the first contribution date`}.`;
        if (next.periods && !frequency) result.content += ' How often will you contribute this amount: monthly, weekly, daily or each payday?';
        if (result.values.delayComparedWithSavingBonus != null) result.content += ` Compared with saving the whole bonus, putting that amount toward debt delays this goal by ${result.values.delayComparedWithSavingBonus} contribution period(s).`;
        result.assumptions.push('Constant-contribution scenario, not proof that future contributions are affordable. No interest or investment returns assumed.');
        if (plan.bonus) result.assumptions.push(`The ${php(plan.bonus)} bonus is hypothetical and one-time${plan.bonusToDebt ? `; ${php(plan.bonusToDebt)} goes to debt instead of this goal` : ''}.`);
      } break;
    }
    case 'goal_contribution': {
      goalInputs();
      let count = plan.periods;
      if (plan.schedule && plan.until) count = contributionDates(plan.schedule, plan.until).length;
      if (count == null) need('contribution_dates', 'What is the deadline and first saving/payday date, or the exact number of contributions remaining?');
      if (!result.missing.length) {
        const required = requiredContribution(target!, saved!, count!);
        Object.assign(result.values, { remaining: pesos(Math.max(0, cents(target!) - cents(saved!))), contributions: count!, required });
        if (required != null && contribution != null) result.values.extraRequired = pesos(Math.max(0, cents(required) - cents(contribution)));
        result.content = required == null ? 'No contribution dates remain before that deadline. Choose a later deadline or a lower target.' : `Save at least ${php(required)} for each of the ${count} remaining contribution(s), rounded up to centavos.`;
        if (result.values.extraRequired != null) result.content += ` That is ${php(result.values.extraRequired as number)} above the current contribution.`;
        result.assumptions.push('Contribution count is supplied or calendar-counted, not a fixed weeks-per-month approximation.');
      } break;
    }
    case 'goal_split': {
      result.tools.push('goals', 'what_if');
      if (goals.length < 2) need('goals', 'Which goals and priorities should share the saving amount?');
      if (plan.contribution == null) need('shared_surplus', 'What total saving amount is available to split this period?');
      if (!result.missing.length) {
        let left = cents(plan.contribution!);
        const allocations = goals.map(item => { const amount = Math.min(left, Math.max(0, cents(item.target) - cents(item.saved))); left -= amount; result.values[item.name] = pesos(amount); return `${item.name}: ${php(pesos(amount))}`; });
        result.values.unallocated = pesos(left);
        if (plan.periods) {
          const needed = goals.reduce((sum, item) => sum + Math.max(0, cents(item.target) - cents(item.saved)), 0);
          const capacity = cents(plan.contribution!) * plan.periods;
          result.values.combinedRemaining = pesos(needed); result.values.combinedCapacity = pesos(capacity);
          result.values.canFinishAll = capacity >= needed;
        }
        result.content = `One priority-order illustration: ${allocations.join('; ')}. Total allocated: ${php(pesos(cents(plan.contribution!) - left))}.`;
        if (plan.periods) result.content += ` Over ${plan.periods} contributions, the combined ${php(result.values.combinedRemaining as number)} target ${result.values.canFinishAll ? 'fits' : 'exceeds'} the ${php(result.values.combinedCapacity as number)} shared saving capacity.`;
        result.assumptions.push('Goals use the supplied order. Each centavo is allocated once; change the order to protect your preferred goal.');
      } break;
    }
    case 'budget_review': {
      result.tools.push('spending', 'income');
      if (!facts.budget) need('monthly_budget', 'What is your monthly spending limit?');
      if (!p?.recordCount) need('spending_history', 'Record your actual spending before comparing the budget.');
      if (!result.missing.length) {
        Object.assign(result.values, { target: facts.budget!.target, spent: facts.budget!.spent, remaining: pesos(cents(facts.budget!.target) - cents(facts.budget!.spent)) });
        result.content = `Month-to-date spending is ${php(facts.budget!.spent)} against ${php(facts.budget!.target)}, leaving ${php(result.values.remaining as number)} within the limit. Review the largest categories before reducing essential costs.`;
      } break;
    }
    case 'budget_allocate': case 'income_change': {
      result.tools.push('income', 'obligations', 'debts', 'what_if');
      if (plannedIncome == null || (!b.configuredIncome && plan.income == null)) need('income_scenario', 'What received or hypothetical income should this monthly plan use?');
      const baseEssential = monthlyEssentials();
      const essential = pesos(cents(baseEssential) + cents(plan.expenseDelta ?? 0) + Math.round(cents(baseEssential) * (plan.expensePercent ?? 0) / 100));
      if (!result.missing.length) {
        const base = cents(plannedIncome!);
        const changed = Math.max(0, base + Math.round((plan.incomeDelta ?? 0) * 100) + Math.round(base * (plan.incomePercent ?? 0) / 100));
        Object.assign(result.values, { income: pesos(changed), essentials: essential, afterEssentials: pesos(changed - cents(essential)) });
        result.content = `In this hypothetical monthly plan, income is ${php(pesos(changed))}; essential costs and due commitments are ${php(essential)}, leaving ${php(pesos(changed - cents(essential)))} for savings and discretionary needs. Prioritize housing, food, health and time-sensitive bills; choose savings from the remainder.`;
        result.assumptions.push('Configured or stated income is a planning scenario, not cash received. Irregular income needs a low-income scenario as well.');
      } break;
    }
    case 'income_history': {
      result.tools.push('income', 'spending');
      const complete = (p?.spending ?? []).filter(row => row.type === 'INCOME' && row.date < today.slice(0, 7) + '-01');
      const months = new Map<string, number>();
      for (const row of complete) months.set(row.date.slice(0, 7), (months.get(row.date.slice(0, 7)) ?? 0) + cents(row.amount));
      if (months.size < 2) need('income_history', 'Please record at least two completed months of income to compare variability.');
      else {
        result.values.lowestRecordedMonth = pesos(Math.min(...months.values()));
        result.values.averageRecordedMonth = pesos(Math.floor([...months.values()].reduce((sum, amount) => sum + amount, 0) / months.size));
        result.values.months = months.size;
        result.content = `Across ${months.size} completed months with income records, the lowest total is ${php(result.values.lowestRecordedMonth as number)} and the average is ${php(result.values.averageRecordedMonth as number)}. Use the lower figure for an essential-cost scenario; incomplete or missing months limit this comparison.`;
      } break;
    }
    case 'category_spending': case 'spending_compare': {
      const monthStart = today.slice(0, 7) + '-01';
      const start = plan.from ?? monthStart, end = plan.until ?? today;
      const rows = historyRows(start, end);
      if (!result.missing.length) {
        const totals = new Map<string, number>();
        for (const row of rows) totals.set(row.category, (totals.get(row.category) ?? 0) + cents(row.amount));
        const ranked = [...totals].sort((a, b) => b[1] - a[1]);
        result.values.spent = pesos([...totals.values()].reduce((sum, amount) => sum + amount, 0));
        result.values.largestCategory = ranked[0]?.[0] ?? 'No recorded expenses';
        result.values.largestAmount = pesos(ranked[0]?.[1] ?? 0);
        if (plan.operation === 'spending_compare') {
          const previousStart = addMonths(start, -1), previousEnd = addMonths(end, -1);
          const before = historyRows(previousStart, previousEnd);
          const previous = total(before.map(row => row.amount));
          result.values.previous = previous; result.values.difference = pesos(cents(result.values.spent as number) - cents(previous));
          const changes = [...new Set([...rows, ...before].map(row => row.category))].map(category => ({ category,
            delta: total(rows.filter(r => r.category === category).map(r => r.amount)) - total(before.filter(r => r.category === category).map(r => r.amount)) })).sort((a, b) => b.delta - a.delta);
          result.values.mostIncreasedCategory = changes[0]?.category ?? 'None';
          result.values.largestIncrease = Math.round((changes[0]?.delta ?? 0) * 100) / 100;
          result.content = `Recorded spending ${start}–${end}: ${php(result.values.spent as number)}; comparable dates ${previousStart}–${previousEnd}: ${php(previous)}. Change: ${php(result.values.difference as number)}. Largest category increase: ${result.values.mostIncreasedCategory}, ${php(result.values.largestIncrease as number)}.`;
        } else result.content = `Recorded spending ${start}–${end}: ${php(result.values.spent as number)}. Largest category: ${result.values.largestCategory} at ${php(result.values.largestAmount as number)}.`;
        result.assumptions.push(`History coverage ${p?.historyStart}–${p?.historyEnd}; month-to-date is not a completed month. Category labels do not prove a purchase's purpose.`);
      } break;
    }
    case 'history_peak': {
      const rows = historyRows(plan.from ?? p?.historyStart ?? from, plan.until ?? today);
      const monthly = new Map<string, number>();
      for (const row of rows) monthly.set(row.date.slice(0, 7), (monthly.get(row.date.slice(0, 7)) ?? 0) + cents(row.amount));
      const peak = [...monthly].sort((a, b) => b[1] - a[1])[0];
      if (!peak) need('spending_history', 'Please record spending before identifying a highest-spending month.');
      if (!result.missing.length) {
        result.values.month = peak![0]; result.values.amount = pesos(peak![1]);
        const categories = new Map<string, number>();
        for (const row of rows.filter(r => r.date.startsWith(peak![0]))) categories.set(row.category, (categories.get(row.category) ?? 0) + cents(row.amount));
        result.values.largestCategory = [...categories].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
        result.content = `The highest recorded month is ${peak![0]} at ${php(pesos(peak![1]))}; its largest category is ${result.values.largestCategory}. A category total shows association, not proof of what caused the spending. The current month may be incomplete.`;
      } break;
    }
    case 'period_forecast': {
      result.tools.push('accounts', 'spending', 'what_if');
      const monthStart = today.slice(0, 7) + '-01', end = plan.until ?? addMonths(monthStart, 1);
      if (!p?.recordCount || !p.firstRecord || p.firstRecord > monthStart) need('history_coverage', 'Record spending from the beginning of the month before estimating a daily pace.');
      const elapsed = daysBetween(monthStart, today) + 1, remainingDays = Math.max(0, daysBetween(today, end) - 1);
      if (!result.missing.length) {
        const rows = historyRows(monthStart, today);
        const spend = cents(total(rows.map(row => row.amount)));
        if (plan.forecastKind === 'savings') {
          const net = (p?.spending ?? []).filter(row => row.date >= monthStart && row.date <= today).reduce((sum, row) => sum + (row.type === 'SAVINGS_CONTRIBUTION' ? cents(row.amount) : row.type === 'SAVINGS_WITHDRAWAL' ? -cents(row.amount) : 0), 0);
          result.values.estimatedAdditional = pesos(Math.floor(net * remainingDays / elapsed));
          result.content = `At this month's recorded net saving pace, another ${php(result.values.estimatedAdditional as number)} would be saved by ${end}. This estimate does not allocate the same surplus to multiple goals.`;
        } else {
          const projected = Math.ceil(spend * remainingDays / elapsed);
          result.values.estimatedSpending = pesos(projected); result.values.estimatedBalance = pesos(cents(accessible) - projected);
          result.content = `A simple recorded-spending pace estimates ${php(pesos(projected))} of additional spending by ${end}, leaving accessible balances of ${php(result.values.estimatedBalance as number)} before unrecorded future commitments. No future income is assumed.`;
        }
        result.assumptions.push('Linear pace is uncertain: bill days, holidays, missing entries and one-time purchases can change the result.');
      } break;
    }
    case 'spending_cut': {
      result.tools.push('spending', 'what_if');
      let saving: number | null = null;
      if (plan.unitCost != null && plan.from && plan.until && plan.weekdays?.length) {
        if (daysBetween(plan.from, plan.until) > 3660) { need('date_range', 'Choose a comparison range of at most ten years.'); break; }
        const replacement = plan.replacementCost ?? 0;
        let count = 0;
        for (let d = Date.parse(plan.from); d <= Date.parse(plan.until); d += 86400000) if (plan.weekdays.includes(new Date(d).getUTCDay())) count++;
        saving = pesos((cents(plan.unitCost) - cents(replacement)) * count); result.values.occurrences = count;
      } else if (plan.category && plan.percentCut != null) {
        const rows = historyRows(plan.from ?? today.slice(0, 7) + '-01', plan.until ?? today);
        saving = pesos(Math.floor(cents(total(rows.map(row => row.amount))) * plan.percentCut / 100));
        result.assumptions.push('Saving is estimated from recorded spending for the stated period, not guaranteed future spending.');
      } else need('cost_reduction', 'Which category and percentage, or item cost, replacement cost, weekdays and date range should I compare?');
      if (!result.missing.length && saving != null) { result.values.saving = saving; result.content = `This change could save ${php(saving)} for the supplied dates and costs. Protect essential spending first.`; }
      break;
    }
    case 'debt_payoff': case 'debt_compare': {
      result.tools.push('debts', 'what_if');
      const borrowed = facts.loans.filter(row => row.type === 'BORROWED' && (!plan.goalNames?.length || plan.goalNames.includes(row.name)));
      const principal = plan.target ?? (borrowed.length === 1 ? borrowed[0].remaining : undefined);
      if (principal == null) need('debt_principal', 'Which debt and outstanding principal should I calculate?');
      if (plan.interestType == null) need('interest_terms', 'Is the loan interest-free, flat-interest or reducing-balance? What are the rate per payment period and fees?');
      if (plan.feePerPeriod == null || (plan.interestType !== 'interest_free' && plan.rateBpsPerPeriod == null)) need('rate_and_fees', 'What are the interest rate per payment period and fees, including zero if none?');
      let payment = plan.payment;
      if (payment == null && principal != null && plan.periods && plan.interestType === 'interest_free') payment = requiredContribution(principal, 0, plan.periods) ?? undefined;
      if (payment == null) need('debt_payment', 'How much will you pay per period? Interest-bearing deadline plans also need a proposed payment to compare.');
      if (!plan.frequency) need('payment_frequency', 'How often are these payments and interest charges due?');
      if (!result.missing.length) {
        const terms = { principal: principal!, payment: payment!, interestType: plan.interestType!, rateBpsPerPeriod: plan.rateBpsPerPeriod ?? 0, feePerPeriod: plan.feePerPeriod ?? 0 };
        const payoff = debtPayoff(terms);
        Object.assign(result.values, payoff, { payment: payment! });
        if (plan.operation === 'debt_compare') {
          if (plan.delta == null) need('extra_payment', 'How much extra would you pay each period?');
          else { const faster = debtPayoff({ ...terms, payment: pesos(cents(payment!) + cents(plan.delta)) }); result.values.fasterPeriods = faster.periods; result.values.periodsSaved = payoff.periods != null && faster.periods != null ? payoff.periods - faster.periods : null; }
        }
        result.content = payoff.doesNotAmortize ? 'The proposed payment does not cover interest and fees; the principal would not decrease.'
          : `At ${php(payment!)} per ${plan.frequency} payment, repayment takes ${payoff.periods ?? 'more than the supported number of'} period(s); total paid ${payoff.total == null ? 'cannot be estimated in range' : php(payoff.total)}${result.values.periodsSaved != null ? `; the extra payment saves ${result.values.periodsSaved} period(s)` : ''}.`;
        result.assumptions.push('Terms are user-supplied; the current ledger does not record loan interest. No future borrowing or missed payments assumed.');
      } break;
    }
    case 'debt_totals': {
      result.tools.push('debts');
      const amount = total(facts.loans.filter(row => row.type === (plan.lent ? 'LENT' : 'BORROWED')).map(row => row.remaining));
      result.values.remaining = amount;
      result.content = `${plan.lent ? 'Recorded unpaid money lent' : 'Recorded outstanding borrowed principal'}: ${php(amount)}. Interest and fees are not stored; unrecorded debts are not included.`; break;
    }
    case 'debt_budget': {
      result.tools.push('income', 'debts', 'spending', 'what_if');
      if (!p?.recordCount) need('income_history', 'Record received income and debt payments for this period.');
      const end = plan.until ?? businessDateLabel(new Date(b.periodEnd));
      const due = reserve(end).debts;
      const start = businessDateLabel(new Date(b.periodStart));
      const paid = total((p?.spending ?? []).filter(row => row.type === 'DEBT_PAYMENT' && row.date >= start && row.date < end).map(row => row.amount));
      result.values.receivedIncome = b.totalIncome; result.values.paid = paid; result.values.upcoming = due;
      result.values.afterDebt = pesos(cents(b.totalIncome) - cents(paid) - cents(due));
      result.content = `Of ${php(b.totalIncome)} received income this period, ${php(paid)} has gone to debt and ${php(due)} is still due, leaving ${php(result.values.afterDebt as number)} before other spending and commitments.`;
      break;
    }
    case 'bill_reserve': case 'bill_forecast': {
      const end = until ?? addMonths(today, 1), reserves = reserve(end);
      Object.assign(result.values, reserves, { totalReserved: total([reserves.bills, reserves.debts]) });
      result.content = `Recorded unpaid bills through ${end} (exclusive): ${php(reserves.bills)}; borrowed debt installments: ${php(reserves.debts)}. Paid amounts are excluded from reserves. ${plan.operation === 'bill_forecast' ? 'This assumes recorded recurring amounts stay unchanged.' : ''}`;
      const due = p?.obligations.filter(item => !item.due || item.due < end) ?? [];
      if (due.length) result.content += ` Bills: ${due.map(item => `${item.name}, due ${item.due ?? 'not recorded'}`).join('; ')}.`;
      if (plan.purchase != null) { const cash = available(); if (!result.missing.length) result.content += ` After the purchase, ${php(cash.afterPurchase)} remains.`; }
      break;
    }
    case 'bill_cost': {
      result.tools.push('obligations', 'what_if');
      const chosen = (p?.recurringObligations ?? p?.obligations ?? []).filter(row => !plan.billNames || plan.billNames.some(name => name.toLowerCase() === row.name.toLowerCase()));
      if (!chosen.length || (plan.billNames && chosen.length !== plan.billNames.length)) need('bills', 'Which recorded subscriptions or recurring bills should I total?');
      if (!result.missing.length) {
        let monthly = 0;
        for (const row of chosen) monthly += cents(row.amount) * ({ MONTHLY: 1, WEEKLY: 52 / 12, YEARLY: 1 / 12, QUARTERLY: 1 / 3 }[row.frequency] ?? 0);
        result.values.monthlyEquivalent = pesos(Math.ceil(monthly)); result.values.yearlyEquivalent = pesos(Math.ceil(monthly * 12));
        result.content = `These recurring amounts total approximately ${php(result.values.monthlyEquivalent as number)} per month, or ${php(result.values.yearlyEquivalent as number)} per year. This is a planning equivalent; actual calendar occurrences can differ.`;
        result.assumptions.push('52 weeks per year; annual costs are spread over 12 months. Payment history cannot establish an old subscription price if it was not recorded.');
      } break;
    }
    case 'emergency_cover': {
      result.tools.push('accounts', 'goals', 'what_if');
      const baseEssential = monthlyEssentials();
      const essential = pesos(cents(baseEssential) + Math.round(cents(baseEssential) * (plan.expensePercent ?? 0) / 100));
      if (plan.emergencyMonths == null) need('emergency_months', 'How many months of essential expenses should the emergency fund cover?');
      if (!result.missing.length) {
        const full = essentialsThrough(plan.emergencyMonths!);
        result.values.monthlyEssentials = essential; result.values.target = pesos(cents(full) + Math.round(cents(full) * (plan.expensePercent ?? 0) / 100));
        result.content = `A ${plan.emergencyMonths}-month illustration through ${addMonths(today, plan.emergencyMonths!)} requires ${php(result.values.target as number)}, counting actual days and recorded bill/debt occurrences. The first one-month period costs ${php(essential)}. Unrecorded costs and future price changes are excluded.`;
      } break;
    }
    case 'school_budget': {
      result.tools.push('income', 'what_if');
      if (plan.income == null) need('allowance', 'How much allowance will actually be available for this school period?');
      if (plan.schoolDays == null) need('school_days', 'How many actual school/OJT days are in this period, excluding holidays?');
      if (plan.dailyFood == null) need('daily_food', 'How much is food per school day?');
      if (plan.dailyTransport == null) need('daily_transport', 'How much is return transport per school day?');
      if (plan.otherCosts == null) need('other_school_costs', 'How much is needed for supplies, printing and other school costs, including zero if none?');
      if (!result.missing.length) {
        const costs = pesos((cents(plan.dailyFood!) + cents(plan.dailyTransport!)) * plan.schoolDays! + cents(plan.otherCosts!));
        Object.assign(result.values, { costs, remaining: pesos(cents(plan.income!) - cents(costs)) });
        result.content = `For ${plan.schoolDays} actual school days, food, return transport and other costs total ${php(costs)}. From the stated ${php(plan.income!)} allowance, ${php(result.values.remaining as number)} remains. This is a hypothetical allowance plan.`;
      } break;
    }
    case 'cost_plan': {
      result.tools.push('what_if');
      if (plan.target == null) need('full_cost', 'What is the full scenario cost, including deposits, fees, transport and other one-time costs?');
      if (plan.alternativeCost == null) need('alternative_cost', 'What is the comparable alternative cost for the same period?');
      if (!result.missing.length) { result.values.difference = pesos(cents(plan.target!) - cents(plan.alternativeCost!)); result.content = `For the same supplied period, the first option costs ${php(result.values.difference as number)} more than the alternative. Compare recurring and one-time costs separately before deciding.`; }
      break;
    }
    case 'missing_info': {
      goalInputs();
      if (contribution == null) need('contribution', 'What affordable contribution and frequency should I use?');
      if (!plan.schedule) need('contribution_dates', 'When is the first contribution, and what is the deadline or confirmed payday schedule?');
      result.content = result.missing.length ? '' : 'The target, dedicated savings, contribution and schedule are available. Refresh your recorded balances and commitments before deciding affordability.';
      break;
    }
  }
  result.tools = [...new Set(result.tools)];
  if (result.missing.length) {
    result.content = goalQuestion ? questions[0] : questions.join('\n');
  }
  if (goalQuestion) {
    const known = [
      goal ? `Using your recorded "${goal.name}" goal.` : '',
      target != null ? `Target: ${php(target)}.` : '',
      saved != null ? `Saved for this target: ${php(saved)}.` : '',
      contribution != null ? `${plan.contribution == null && goal ? 'Recorded monthly allocation' : 'Planned contribution'}: ${php(contribution)}${plan.contribution != null && frequency ? ` ${frequency}` : ''}.` : '',
    ].filter(Boolean).join(' ');
    const records = recordedSavingContext();
    result.sections = { known, answer: result.missing.length ? '' : result.content, records,
      question: result.missing.length ? questions[0] : '', qualifications: result.missing.length ? '' : result.assumptions.slice(1).join(' ') };
    result.content = [known, result.missing.length ? '' : result.content, records,
      result.missing.length ? questions[0] : result.assumptions.slice(1).join(' ')].filter(Boolean).join('\n\n');
    // Keep the complete technical assumptions in response metadata. In chat,
    // show the relevant qualification beside the actual user's figures.
    result.tools = [...new Set(result.tools)];
  } else {
    result.content += `\n\n${result.assumptions.join(' ')}${p ? ` Snapshot: ${businessDateLabel(new Date(p.asOf))}, ${p.timezone}.` : ''}`;
  }
  return result;
}
