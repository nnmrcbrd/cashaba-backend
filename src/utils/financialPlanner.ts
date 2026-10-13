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
  purchase: peso.optional(), income: peso.optional(), newIncome: peso.optional(), incomeDelta: z.number().finite().min(-1e9).max(1e9).optional(),
  purchaseFunding: z.enum(['cash', 'goal_savings', 'planned_contributions']).optional(),
  goalChangeKind: z.literal('purchase').optional(),
  goalMode: z.enum(['cheaper_target', 'build_savings', 'recorded_completion']).optional(), usesRecordedGoal: z.boolean().optional(),
  goalPurpose: z.enum(['cost', 'bills', 'school']).optional(), needsIncomeChange: z.boolean().optional(),
  reviewKind: z.enum(['subscription_change', 'practical_change', 'small_purchases']).optional(),
  debtMode: z.enum(['priority', 'new_loan']).optional(),
  finishMonthsEarlier: z.number().int().positive().max(1200).optional(), sincePayday: z.boolean().optional(),
  subscriptionSelection: z.boolean().optional(), desiredSaving: peso.optional(),
  daysPerWeek: z.number().int().min(1).max(7).optional(),
  costMode: z.enum(['total', 'comparison', 'income_effect']).optional(),
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
  const purchaseImpact = plan.operation === 'goal_change' && (plan.goalChangeKind === 'purchase' || plan.purchase != null);
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
    if (plan.usesRecordedGoal && !goal && facts.goals.length && target == null) {
      need('goal_selection', 'Which recorded savings goal should I use?');
      return;
    }
    if (target != null) result.values.target = target;
    if (saved != null) result.values.saved = saved;
    if (contribution != null) result.values.contribution = contribution;
    if (target != null && saved != null) result.values.remaining = pesos(Math.max(0, cents(target) - cents(saved)));
    if (plan.goalMode === 'cheaper_target' && plan.target == null) need('cheaper_target', 'What cheaper price in PHP should I compare with your recorded goal?');
    else if (plan.goalMode === 'cheaper_target' && !goal && plan.alternativeCost == null) need('original_target', 'What was the original target price in PHP to compare with this cheaper price?');
    else if (target == null) need('target_price', plan.goalPurpose === 'bills' ? 'What total bill amount needs to be funded, and when is it due?'
      : plan.goalPurpose === 'school' ? 'What total printing, supplies or enrollment cost needs to be funded?'
      : plan.goalPurpose === 'cost' ? 'What total purchase or planned expense cost in PHP should I use?'
      : 'What is the target price in PHP? I have no verified current price source.');
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
      if (purchaseImpact) {
        result.tools.push('goals', 'what_if');
        if (plan.purchase == null) {
          need('purchase_price', 'What purchase cost in PHP should I use for this scenario?'); break;
        }
        result.values.purchase = plan.purchase!;
        if (!plan.purchaseFunding) {
          need('purchase_funding', 'Will you pay from available cash, withdraw from a specific savings goal, or reduce planned contributions?');
          break;
        }
        result.values.purchaseFunding = plan.purchaseFunding;
        if (plan.purchaseFunding === 'cash') {
          result.tools.push('accounts');
          if (!facts.accounts.some(a => a.kind === 'ASSET' && ['CASH', 'BANK', 'EWALLET'].includes(a.accountType ?? ''))) {
            need('accessible_accounts', 'Which Cash, bank or e-wallet account will fund this purchase?'); break;
          }
          const after = pesos(cents(accessible) - cents(plan.purchase!));
          Object.assign(result.values, { accessible, walletBalanceAfterPurchase: after });
          result.content = `Paying ${php(plan.purchase!)} entirely from accessible wallet cash would reduce recorded wallet cash from ${php(accessible)} to ${php(after)}. Your saved goal balances remain unchanged if you do not withdraw from them and keep their contributions unchanged.`;
          if (after < 0) need('funding_shortfall', `Accessible wallet cash is short by ${php(-after)}. Where would that remaining purchase cost come from?`);
          result.assumptions.push('This is a conditional cash-balance effect, before bills, debt, essential needs and future contributions. It does not establish affordability.');
          break;
        }
        if (!goal || goals.length !== 1) {
          need('goal_selection', plan.purchaseFunding === 'goal_savings' ? 'Which recorded savings goal would you withdraw from?' : 'Which recorded goal would have its planned contributions reduced?');
          break;
        }
        const allocation = goal.monthlyAllocation;
        const baseline = goalTimeline(goal.target, goal.saved, allocation);
        Object.assign(result.values, { target: goal.target, saved: goal.saved, contribution: allocation, baselinePeriods: baseline.periods });
        if (plan.purchaseFunding === 'goal_savings') {
          if (cents(goal.saved) < cents(plan.purchase!)) {
            result.values.fundingShortfall = pesos(cents(plan.purchase!) - cents(goal.saved));
            need('funding_shortfall', `Your "${goal.name}" goal has ${php(goal.saved)} saved, leaving ${php(result.values.fundingShortfall as number)} of the purchase unfunded. Where would the remainder come from?`);
            break;
          }
          const after = pesos(cents(goal.saved) - cents(plan.purchase!));
          const next = goalTimeline(goal.target, after, allocation);
          Object.assign(result.values, next, { savedAfterPurchase: after,
            delayPeriods: baseline.periods != null && next.periods != null ? next.periods - baseline.periods : null });
          result.content = `Withdrawing ${php(plan.purchase!)} from your "${goal.name}" goal would reduce its saved balance from ${php(goal.saved)} to ${php(after)}. `;
          if (next.periods != null && baseline.periods != null) result.content += `At its recorded ${php(allocation)} monthly allocation, it would need ${next.periods} contributions instead of ${baseline.periods}, a delay of ${next.periods - baseline.periods} monthly contribution(s).`;
          else result.content += 'Its recorded monthly allocation is zero, so a completion timeline cannot be calculated.';
        } else {
          if (plan.contribution == null || plan.periods == null) {
            need('contribution_plan', `For your "${goal.name}" goal, currently allocated ${php(allocation)} per month, what monthly contribution would remain, and for how many months?`); break;
          }
          if (plan.frequency && plan.frequency !== 'monthly' || plan.contribution > allocation || allocation <= 0) {
            need('contribution_plan', `What lower monthly contribution should replace the recorded ${php(allocation)} monthly allocation, and for how many months?`); break;
          }
          const redirected = pesos((cents(allocation) - cents(plan.contribution)) * plan.periods);
          result.values.redirectedContributions = redirected;
          if (cents(redirected) < cents(plan.purchase!)) {
            result.values.fundingShortfall = pesos(cents(plan.purchase!) - cents(redirected));
            need('funding_shortfall', `That plan redirects ${php(redirected)}, leaving ${php(result.values.fundingShortfall as number)} of the purchase unfunded. How will you cover the remainder?`); break;
          }
          const remaining = Math.max(0, cents(goal.target) - cents(goal.saved));
          const reduced = cents(plan.contribution), usual = cents(allocation);
          const completesDuringReduction = reduced > 0 && Math.ceil(remaining / reduced) <= plan.periods;
          const periods = remaining === 0 ? 0 : completesDuringReduction ? Math.ceil(remaining / reduced)
            : plan.periods + Math.ceil(Math.max(0, remaining - reduced * plan.periods) / usual);
          Object.assign(result.values, { remaining: pesos(remaining), contribution: plan.contribution, periods,
            delayPeriods: baseline.periods != null ? periods - baseline.periods : null });
          result.content = `Reducing your "${goal.name}" contribution from ${php(allocation)} to ${php(plan.contribution)} monthly for ${plan.periods} month(s) redirects ${php(redirected)} toward the ${php(plan.purchase!)} purchase. Resuming ${php(allocation)} monthly afterward would require ${periods} contributions in total, compared with ${baseline.periods} at the original pace.`;
          if (redirected > plan.purchase!) result.content += ` The extra ${php(redirected - plan.purchase!)} is not assigned to another goal in this scenario.`;
        }
        result.content += ' Your other recorded goal balances and allocations remain unchanged in this scenario.';
        result.assumptions.push('Hypothetical only; no purchase, withdrawal or contribution has been recorded. Constant monthly allocation assumed, with no interest or investment returns. A calendar completion date requires contribution dates.');
        break;
      }
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
        const originalTarget = goal?.target ?? plan.alternativeCost;
        if (plan.goalMode === 'cheaper_target' && originalTarget != null) {
          const original = goalTimeline(originalTarget, saved!, contribution!);
          result.values.baselinePeriods = original.periods;
          result.values.periodsSaved = original.periods != null && next.periods != null ? original.periods - next.periods : null;
        }
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
        if (plan.goalMode === 'cheaper_target' && originalTarget != null && result.values.periodsSaved != null) result.content += ` Compared with the ${goal ? 'recorded' : 'supplied original'} ${php(originalTarget)} target, this changes the timeline from ${result.values.baselinePeriods} to ${next.periods} contributions, saving ${result.values.periodsSaved} contribution period(s).`;
        if (result.values.delayComparedWithSavingBonus != null) result.content += ` Compared with saving the whole bonus, putting that amount toward debt delays this goal by ${result.values.delayComparedWithSavingBonus} contribution period(s).`;
        result.assumptions.push('Constant-contribution scenario, not proof that future contributions are affordable. No interest or investment returns assumed.');
        if (plan.bonus) result.assumptions.push(`The ${php(plan.bonus)} bonus is hypothetical and one-time${plan.bonusToDebt ? `; ${php(plan.bonusToDebt)} goes to debt instead of this goal` : ''}.`);
      } break;
    }
    case 'goal_contribution': {
      if (plan.goalMode === 'build_savings') {
        result.tools.push('goals', 'what_if');
        if (!goal && saved == null) need('saved_balance', 'How much is already saved for this emergency fund?');
        if (contribution == null) need('contribution', 'How much will you contribute each month?');
        if (frequency !== 'monthly') need('contribution_frequency', 'What monthly contribution should I use for this six-month projection?');
        if (plan.periods == null) need('contribution_dates', 'How many monthly contributions should the projection include?');
        if (!result.missing.length) {
          const additional = pesos(cents(contribution!) * plan.periods!);
          Object.assign(result.values, { projectedAdditional: additional, projectedSaved: total([saved!, additional]), contributions: plan.periods! });
          if (plan.target != null && plan.saved != null) result.values.required = requiredContribution(plan.target, plan.saved, plan.periods!);
          result.content = `At ${php(contribution!)} per month, ${plan.periods} monthly contributions would add ${php(additional)}, increasing the specified saved balance from ${php(saved!)} to ${php(result.values.projectedSaved as number)}.`;
          result.assumptions.push('Constant monthly contributions, excluding interest or investment returns; future contributions are not guaranteed affordable.');
        }
        break;
      }
      goalInputs();
      let count = plan.periods;
      if (plan.schedule && plan.until) count = contributionDates(plan.schedule, plan.until).length;
      if (count == null && plan.finishMonthsEarlier && target != null && saved != null && contribution != null && frequency === 'monthly') {
        const baseline = goalTimeline(target, saved, contribution);
        if (baseline.periods != null) { count = Math.max(0, baseline.periods - plan.finishMonthsEarlier); result.values.baselinePeriods = baseline.periods; }
      }
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
      if (plan.goalMode === 'recorded_completion' && plan.contribution == null) {
        const selected = goals.length ? goals : facts.goals;
        const periods = plan.periods ?? (plan.schedule && plan.until ? contributionDates(plan.schedule, plan.until).length : undefined);
        if (!selected.length) need('goals', 'Which recorded savings goals should I assess?');
        if (periods == null) need('contribution_dates', 'What is the first remaining monthly contribution date, or exact number of contributions before year-end?');
        result.content = selected.map(item => {
          const pace = goalTimeline(item.target, item.saved, item.monthlyAllocation);
          return `${item.name}: ${php(pace.remaining)} remaining; ${php(item.monthlyAllocation)} allocated monthly; ${pace.periods == null ? 'no timeline with a zero allocation' : `${pace.periods} contributions needed`}.`;
        }).join('\n');
        if (periods != null) {
          const achievable = selected.filter(item => goalTimeline(item.target, item.saved, item.monthlyAllocation).periods != null && goalTimeline(item.target, item.saved, item.monthlyAllocation).periods! <= periods);
          result.values.achievableGoals = achievable.map(item => item.name).join(', ') || 'None';
          result.values.contributions = periods;
          result.content += `\nWith ${periods} remaining contributions, goals that fit these unchanged allocations: ${result.values.achievableGoals}.`;
        } else questions[0] = `${result.content}\n${questions[0]}`;
        result.assumptions.push('Recorded allocations are plans; completion is conditional on making every contribution, without interest or withdrawals.');
        break;
      }
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
        const remaining = result.values.remaining as number;
        result.content = `Month-to-date spending is ${php(facts.budget!.spent)} against ${php(facts.budget!.target)}, ${remaining < 0 ? `exceeding the limit by ${php(-remaining)}` : `leaving ${php(remaining)} within the limit`}. Review the largest categories before reducing essential costs.`;
      } break;
    }
    case 'budget_allocate': case 'income_change': {
      result.tools.push('income', 'obligations', 'debts', 'what_if');
      if (plan.needsIncomeChange && plan.income == null && plan.incomeDelta == null && plan.incomePercent == null) need('income_change', 'What reduced income amount, decrease amount or percentage should I use?');
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
      if (plan.sincePayday && !plan.from && !p?.lastPayday) { need('last_payday', 'When was your last payday?'); break; }
      if (plan.reviewKind === 'subscription_change' && !plan.category) { need('subscription_price_history', 'Which subscriptions changed, and what were their old and new prices and effective dates? Current bill totals alone cannot identify price increases.'); break; }
      const monthStart = today.slice(0, 7) + '-01';
      const start = plan.from ?? (plan.sincePayday ? p?.lastPayday : null) ?? monthStart, end = plan.until ?? today;
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
        if (plan.reviewKind === 'practical_change') {
          const expense = rows.filter(row => row.type === 'EXPENSE');
          const groups = [...new Set(expense.map(row => row.category))].map(category => ({ category, spent: total(expense.filter(row => row.category === category).map(row => row.amount)) })).sort((a, b) => b.spent - a.spent);
          result.content += groups.length ? ` One practical step this week: review the individual purchases in ${groups[0].category}, your largest recorded expense category in these dates at ${php(groups[0].spent)}, then set a limit for its optional purchases. Keep essential costs and due payments protected.` : ' One practical step this week: record each expense with its category so you can choose an informed spending limit.';
        }
        if (plan.reviewKind === 'small_purchases') result.content += ' To measure how small purchases affect goal progress, identify their category or actual item costs. These category totals alone do not show which purchases were small or how much goal contributions would change.';
        if (plan.reviewKind === 'subscription_change') result.content += ' This is recorded spending for the selected category, not a historical subscription-price comparison. Old and new prices with effective dates are needed to identify increases.';
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
      const monthStart = today.slice(0, 7) + '-01';
      // Forecast horizons use the exclusive period boundary, like ledger
      // queries. Present the last included day, not the next month's first day.
      const end = plan.until ?? addMonths(monthStart, 1);
      const through = new Date(Date.parse(end) - 86400000).toISOString().slice(0, 10);
      if (!facts.accounts.some(a => a.kind === 'ASSET' && ['CASH', 'BANK', 'EWALLET'].includes(a.accountType ?? ''))) need('accessible_accounts', 'Which Cash, bank or e-wallet balances should I use for this forecast?');
      if (!p?.recordCount || !p.firstRecord || p.firstRecord > monthStart) need('history_coverage', 'Record spending from the beginning of the month before estimating a daily pace.');
      const elapsed = daysBetween(monthStart, today) + 1, remainingDays = Math.max(0, daysBetween(today, through));
      Object.assign(result.values, { accessible, asOf: today, until: end, through, elapsedDays: elapsed, remainingDays });
      if (!result.missing.length) {
        const rows = historyRows(monthStart, today);
        const spend = cents(total(rows.map(row => row.amount)));
        result.values.recordedSpending = pesos(spend);
        if (plan.forecastKind === 'savings') {
          const net = (p?.spending ?? []).filter(row => row.date >= monthStart && row.date <= today).reduce((sum, row) => sum + (row.type === 'SAVINGS_CONTRIBUTION' ? cents(row.amount) : row.type === 'SAVINGS_WITHDRAWAL' ? -cents(row.amount) : 0), 0);
          result.values.estimatedAdditional = pesos(Math.floor(net * remainingDays / elapsed));
          result.content = `At this month's recorded net saving pace, another ${php(result.values.estimatedAdditional as number)} would be saved by ${through}. This estimate does not allocate the same surplus to multiple goals.`;
        } else {
          const projected = Math.ceil(spend * remainingDays / elapsed);
          result.values.estimatedSpending = pesos(projected); result.values.estimatedBalance = pesos(cents(accessible) - projected);
          result.content = `Your accessible wallet balances total ${php(accessible)}. You recorded ${php(pesos(spend))} of spending over ${elapsed} day(s) this month. At that pace, estimated additional spending over the remaining ${remainingDays} day(s) is ${php(pesos(projected))}, leaving a projected wallet balance of ${php(result.values.estimatedBalance as number)} by ${through}, before other future payments or savings contributions. No future income is assumed.`;
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
      } else if (plan.daysPerWeek != null) {
        if (plan.unitCost == null) need('meal_cost', 'How much does your current lunch cost per day?');
        if (plan.replacementCost == null) need('replacement_cost', 'How much would a packed lunch cost per day?');
        if (!result.missing.length) {
          saving = pesos((cents(plan.unitCost!) - cents(plan.replacementCost!)) * plan.daysPerWeek);
          result.values.weeklySaving = saving;
          result.assumptions.push(`Comparison covers ${plan.daysPerWeek} lunches per week at the supplied costs, not a guessed monthly calendar.`);
        }
      } else if (plan.category && plan.percentCut != null) {
        const rows = historyRows(plan.from ?? today.slice(0, 7) + '-01', plan.until ?? today);
        saving = pesos(Math.floor(cents(total(rows.map(row => row.amount))) * plan.percentCut / 100));
        result.assumptions.push('Saving is estimated from recorded spending for the stated period, not guaranteed future spending.');
      } else if (plan.desiredSaving != null) {
        const rows = historyRows(today.slice(0, 7) + '-01', today).filter(row => row.type === 'EXPENSE');
        const categories = [...new Set(rows.map(row => row.category))].map(category => ({ category, spent: total(rows.filter(row => row.category === category).map(row => row.amount)) })).sort((a, b) => b.spent - a.spent);
        result.values.requestedSaving = plan.desiredSaving;
        need('cost_reduction', `To assess a ${php(plan.desiredSaving)} monthly reduction, which costs could you safely reduce? Recorded month-to-date categories: ${categories.map(row => `${row.category} ${php(row.spent)}`).join('; ') || 'none'}. These totals do not establish which expenses are optional or a full month's spending.`);
      } else need('cost_reduction', 'Which category and percentage, or item cost, replacement cost, weekdays and date range should I compare?');
      if (!result.missing.length && saving != null) { result.values.saving = saving; result.content = `This change could save ${php(saving)} ${plan.daysPerWeek != null && result.values.weeklySaving != null ? 'per week' : 'for the supplied dates and costs'}. Protect essential spending first.`; }
      break;
    }
    case 'debt_payoff': case 'debt_compare': {
      result.tools.push('debts', 'what_if');
      const borrowed = facts.loans.filter(row => row.type === 'BORROWED' && (!plan.goalNames?.length || plan.goalNames.includes(row.name)));
      const dueList = borrowed.map(row => `${row.name} ${p?.debts.find(item => item.name === row.name)?.due ?? 'not recorded'}`).join('; ');
      if (plan.debtMode === 'priority' && plan.interestType == null) { need('priority_terms', `To compare repayment priorities, what are each debt's interest rate, fees and minimum payment? Recorded due dates: ${dueList || 'no borrowed debts recorded'}. Protect required payments first; interest terms are not stored.`); break; }
      const principal = plan.target ?? (plan.debtMode !== 'new_loan' && borrowed.length === 1 ? borrowed[0].remaining : undefined);
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
        if (plan.periods && plan.frequency === 'monthly') result.assumptions.push(`Assumes ${plan.periods} regular monthly installments. Calendar payoff dates require the first payment date.`);
        if (plan.debtMode === 'new_loan') result.content += ' This repayment cost would be an additional commitment; compare it with cash after essential costs, existing debts and bills before deciding whether the new loan fits.';
        if (plan.debtMode === 'priority') result.content += ` Recorded due dates: ${dueList}. This calculation uses the supplied terms for the selected debt; ranking multiple debts requires each debt's actual terms.`;
      } break;
    }
    case 'debt_totals': {
      result.tools.push('debts');
      const amount = total(facts.loans.filter(row => row.type === (plan.lent ? 'LENT' : 'BORROWED')).map(row => row.remaining));
      result.values.remaining = amount;
      result.content = `${plan.lent ? 'Recorded unpaid money lent' : 'Recorded outstanding borrowed principal'}: ${php(amount)}. Interest and fees are not stored; unrecorded debts are not included.`;
      if (!plan.lent) {
        const accountBalances = facts.accounts.filter(account => account.kind === 'LIABILITY' || ['LOAN', 'CREDIT_CARD'].includes(account.accountType ?? ''));
        if (accountBalances.length) {
          const accountBalance = total(accountBalances.map(account => Math.max(0, account.balance)));
          result.values.loanCreditAccountBalances = accountBalance;
          result.content += ` Separately tracked loan, credit and liability balances in Wallet & Accounts: ${php(accountBalance)}. These records can overlap the borrowed-loan entries, so a combined total requires confirming they represent different debts.`;
        }
      }
      break;
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
      if (plan.subscriptionSelection && !plan.billNames?.length) { need('bills', 'Which recorded subscriptions should I include? Recurring bills such as house rent are not automatically treated as subscriptions.'); break; }
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
      if (plan.costMode === 'total') {
        if (!result.missing.length) {
          result.values.fullCost = plan.target!;
          result.content = `The full move-in cost you supplied is ${php(plan.target!)}. This is the amount to set aside for the stated deposits, furniture and other included move-in costs. Add any costs not included in that total; keep ongoing rent, essential expenses and emergency savings separate. This does not establish that the move is affordable.`;
        }
        break;
      }
      if (plan.alternativeCost == null) need('alternative_cost', 'What is the comparable alternative cost for the same period?');
      if (plan.costMode === 'income_effect') {
        if (plan.income == null) need('scenario_income', 'What is your current take-home income for the comparison period?');
        if (plan.newIncome == null && plan.incomeDelta == null) need('new_income', 'What would your take-home income be in the new scenario for the same period, or how much would it change? State the same income explicitly if unchanged.');
        if (plan.income != null && plan.newIncome != null && plan.incomeDelta != null
          && cents(plan.newIncome) !== cents(plan.income) + Math.round(plan.incomeDelta * 100)) need('new_income', 'The supplied new income and income change conflict. Which should this scenario use?');
        if (plan.income != null && plan.incomeDelta != null && cents(plan.income) + Math.round(plan.incomeDelta * 100) < 0) need('new_income', 'The supplied income reduction exceeds current income. What is the new take-home income?');
      }
      if (!result.missing.length) {
        const difference = pesos(cents(plan.target!) - cents(plan.alternativeCost!));
        result.values.difference = difference;
        const comparison = difference === 0 ? 'The two options have the same supplied cost.'
          : `The first option costs ${php(Math.abs(difference))} ${difference > 0 ? 'more' : 'less'} than the alternative.`;
        result.content = `For the same supplied period, ${comparison} Compare recurring and one-time costs separately before deciding.`;
        if (plan.costMode === 'income_effect') {
          const newIncome = plan.newIncome ?? pesos(cents(plan.income!) + Math.round(plan.incomeDelta! * 100));
          const baselineRemaining = pesos(cents(plan.income!) - cents(plan.alternativeCost!));
          const remaining = pesos(cents(newIncome) - cents(plan.target!));
          const netEffect = pesos(cents(newIncome) - cents(plan.target!) - cents(plan.income!) + cents(plan.alternativeCost!));
          Object.assign(result.values, { newIncome, baselineRemaining, remaining, netEffect });
          const effect = netEffect === 0 ? 'There is no change in the money remaining.'
            : `You would have ${php(Math.abs(netEffect))} ${netEffect > 0 ? 'more' : 'less'} remaining for that period.`;
          result.content = `In the hypothetical comparison, current take-home income of ${php(plan.income!)} minus current full costs of ${php(plan.alternativeCost!)} leaves ${php(baselineRemaining)}. New take-home income of ${php(newIncome)} minus new full costs of ${php(plan.target!)} leaves ${php(remaining)}. ${effect} This includes both the income change and cost change. Keep one-time startup costs separate from recurring costs. This is conditional on the supplied income and costs; any omitted bills, debt, essential expenses or savings reduce the remainder. It does not establish affordability.`;
        }
      }
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
  if (purchaseImpact) {
    const known = plan.purchase == null ? '' : `Purchase cost: ${php(plan.purchase)}.`;
    const records = facts.goals.length ? `Recorded goals before this hypothetical purchase:\n${facts.goals.slice(0, 4).map(item => `• ${item.name}: ${php(item.saved)} saved toward ${php(item.target)}; ${php(item.monthlyAllocation)} allocated monthly.`).join('\n')}${facts.goals.length > 4 ? '\nAdditional recorded goals are not listed here.' : ''}` : 'No savings goals are recorded yet.';
    result.sections = { known, answer: result.content, records, question: questions[0] ?? '', qualifications: result.assumptions.slice(1).join(' ') };
    result.content = [known, result.content, records, questions[0], result.assumptions.slice(1).join(' ')].filter(Boolean).join('\n\n');
    return result;
  }
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
