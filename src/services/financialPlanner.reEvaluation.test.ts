import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerateContentResponse } from '@google/genai';
import bank from '@/evaluation/aiQuestions.v1.json';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan, type PlanningContext } from '@/utils/financialPlanner';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from './financialPlanner';
import { isStructuredPlanningReply } from '@/utils/planningExplicitInputs';

const offline = { reserve: async () => {}, generate: async () => { throw new Error('Offline provider'); } };
const context = (plan: PlanningContext['plan']): PlanningContext => ({ kind: 'FINANCIAL_PLAN_V1', owner: 'review-owner', updatedAt: new Date().toISOString(), plan });
const calculate = (message: string, facts = completeFacts(), previous?: PlanningContext) => executeFinancialPlan(localFinancialPlan(message, facts, previous), facts);

test('all 150 questions retain their calculation after a saved missing-records reply receives fresh records and typed details', async () => {
  const failures: unknown[] = [];
  for (const row of bank.questions) {
    const first = await answerFinancialPlan(row.question, missingFacts(), 'review-owner', [], offline);
    if (!first?.requiresClarification) continue;
    const details = Object.fromEntries(Object.entries(row.completeInput).filter(([key]) => !['operation', 'language'].includes(key)));
    const next = await answerFinancialPlan(`Details: ${JSON.stringify(details)}`, completeFacts(), 'review-owner',
      [{ question: row.question, answer: first.content, pendingAction: JSON.parse(JSON.stringify(first.context)) }], offline);
    const wrong = Object.entries(row.expected).filter(([key, value]) => next?.result.values[key] !== value);
    if (!next || next.requiresClarification || next.result.operation !== row.completeInput.operation || wrong.length) failures.push({ id: row.id, wrong, operation: next?.result.operation, missing: next?.result.missing });
  }
  assert.deepEqual(failures, []);
});

test('the 150-question sequence does not inherit another goal target or shared contribution amount', async () => {
  const history: Array<{ question: string; answer: string; pendingAction: PlanningContext }> = [], failures: unknown[] = [];
  for (const row of bank.questions) {
    const details = Object.fromEntries(Object.entries(row.completeInput).filter(([key]) => !['operation', 'language'].includes(key)));
    const next = await answerFinancialPlan(`${row.question}\nDetails: ${JSON.stringify(details)}`, completeFacts(), 'review-owner', history.slice(-6), offline);
    const wrong = Object.entries(row.expected).filter(([key, value]) => next?.result.values[key] !== value);
    if (!next || next.requiresClarification || wrong.length) failures.push({ id: row.id, wrong, missing: next?.result.missing });
    if (next) history.push({ question: row.question, answer: next.content, pendingAction: next.context });
  }
  assert.deepEqual(failures, []);
});

test('a new bonus or skipped-saving scenario clears the earlier purchase funding workflow', () => {
  const facts = completeFacts();
  const previous = context(localFinancialPlan('How will buying a ₱10000 tablet affect my other savings goals?', facts)!);
  const bonus = localFinancialPlan('If I receive a ₱5000 bonus, how much closer will I be to my Laptop goal?', facts, previous)!;
  assert.equal(bonus.purchase, undefined);
  assert.equal(bonus.goalChangeKind, undefined);
  assert.equal(executeFinancialPlan(bonus, facts).values.periods, 9);
  const skip = calculate('If I skip saving this month, how much will my Laptop goal be delayed?', facts, previous);
  assert.equal(skip.values.periodsSaved, -1);
  assert.deepEqual(skip.missing, []);
});

test('a cheaper phone comparison requests the missing cheaper price and then compares the recorded pace', () => {
  const facts = completeFacts();
  const original = localFinancialPlan(bank.questions[12].question, facts)!;
  const first = executeFinancialPlan(original, facts);
  assert.ok(first.missing.includes('cheaper_target'));
  assert.equal(first.values.periods, undefined);
  const next = calculate('price: 20000', facts, context(original));
  assert.equal(next.values.periods, 6);
  assert.equal(next.values.baselinePeriods, 10);
  assert.equal(next.values.periodsSaved, 4);
});

test('a cheaper-price comparison without a recorded goal requests its original price rather than inventing an earlier timeline', () => {
  const facts = missingFacts(), original = localFinancialPlan('If I choose a cheaper phone for ₱20000, how much earlier can I reach my goal? Saved: 5000. I save 2500 monthly.', facts)!;
  const first = executeFinancialPlan(original, facts);
  assert.ok(first.missing.includes('original_target'));
  assert.equal(first.values.periodsSaved, undefined);
  const next = calculate('30000', facts, context(original));
  assert.equal(next.values.baselinePeriods, 10);
  assert.equal(next.values.periods, 6);
  assert.equal(next.values.periodsSaved, 4);
});

test('goal-selection and two-month-earlier questions use recorded goals rather than asking for an unrelated product price', () => {
  const selection = calculate(bank.questions[35].question);
  assert.ok(selection.missing.includes('goal_selection'));
  assert.doesNotMatch(selection.content, /What is the target price/);
  const earlier = calculate('How much more do I need to save each month for my Laptop goal to finish two months earlier?');
  assert.equal(earlier.values.required, 5000);
  assert.equal(earlier.values.extraRequired, 1000);
});

test('a delayed payday and a last-payday lookup use the actual requested horizon', () => {
  const facts = completeFacts();
  const delayed = calculate(bank.questions[28].question, facts);
  assert.equal(delayed.values.available, 36100);
  assert.equal(delayed.values.dailyLimit, 2578.57);
  facts.planning!.lastPayday = '2026-10-05';
  assert.equal(calculate(bank.questions[23].question, facts).values.spent, 1500);
  facts.planning!.lastPayday = null;
  assert.ok(calculate(bank.questions[23].question, facts).missing.includes('last_payday'));
});

test('the stated school-food cost is preserved and never becomes the allowance income', () => {
  const plan = localFinancialPlan(bank.questions[66].question, completeFacts())!;
  assert.equal(plan.dailyFood, 150);
  assert.equal(plan.income, undefined);
  const result = executeFinancialPlan(plan, completeFacts());
  assert.ok(result.missing.includes('allowance'));
  assert.ok(!result.missing.includes('daily_food'));
  const fiveDays = localFinancialPlan(bank.questions[61].question, completeFacts())!;
  assert.equal(fiveDays.schoolDays, 5);
});

test('food-delivery questions apply their category and stated half-cut without another percentage question', () => {
  const facts = completeFacts();
  assert.equal(calculate(bank.questions[138].question, facts).values.spent, 600);
  const half = calculate(bank.questions[139].question, facts);
  assert.equal(half.values.saving, 300);
  assert.deepEqual(half.missing, []);
  assert.ok(calculate(bank.questions[48].question, facts).missing.includes('category_classification'));
});

test('subscription questions do not treat house rent as a chosen subscription', () => {
  for (const index of [78, 80]) {
    const result = calculate(bank.questions[index].question);
    assert.ok(result.missing.includes('bills'));
    assert.equal(result.values.yearlyEquivalent, undefined);
  }
});

test('stopping a priced weekday purchase retains the price and counts the stated next-year calendar', () => {
  const result = calculate(bank.questions[141].question);
  assert.equal(result.values.occurrences, 261);
  assert.equal(result.values.saving, 31320);
  assert.deepEqual(result.missing, []);
});

test('interest-free monthly repayment within one year calculates the required payment after terms are supplied', () => {
  const result = calculate('How much should I pay monthly to clear my loan within one year? No interest and no fees.');
  assert.equal(result.values.payment, 1000);
  assert.equal(result.values.periods, 12);
});

test('a six-month emergency saving projection answers the amount buildable at the recorded rate', () => {
  const result = calculate(bank.questions[118].question);
  assert.equal(result.values.projectedAdditional, 24000);
  assert.equal(result.values.projectedSaved, 44000);
  assert.match(result.content, /six|6.*monthly|6.*contribution/i);
  assert.deepEqual(result.missing, []);
});

test('a month-saving daily limit protects expenses to the month boundary instead of silently stopping at payday', () => {
  const facts = completeFacts(), plan = localFinancialPlan(bank.questions[29].question, facts)!;
  assert.equal(plan.until, '2026-11-01');
  const result = executeFinancialPlan(plan, facts);
  // Oct 8 through Oct 31: 24 days, cash 50000 less protected 10000,
  // bills 2000, debt 500, essentials 2400 and new savings 2000.
  assert.equal(result.values.reserved, 16900);
  assert.equal(result.values.available, 33100);
  assert.equal(result.values.dailyLimit, 1379.16);
});

test('this-week bill queries exclude commitments after Sunday and do not use the payday horizon', () => {
  const facts = completeFacts();
  facts.planning!.obligations.push({ ...facts.planning!.obligations[0], name: 'Later bill', due: '2026-10-13', anchor: '2026-10-13', amount: 1000, paid: 0 });
  const plan = localFinancialPlan(bank.questions[77].question, facts)!;
  assert.equal(plan.until, '2026-10-12');
  const result = executeFinancialPlan(plan, facts);
  assert.equal(result.values.bills, 2000);
  assert.equal(result.values.debts, 0);
  assert.doesNotMatch(result.content, /Later bill/);
});

test('school commuting and subscription-price increases do not become unrelated all-category totals', () => {
  assert.ok(calculate(bank.questions[70].question).missing.includes('category_classification'));
  const result = calculate(bank.questions[79].question);
  assert.ok(result.missing.includes('subscription_price_history'));
  assert.equal(result.values.spent, undefined);
  assert.match(result.content, /old and new prices/);
});

test('unspecified lower income asks for the decrease instead of reporting unchanged income', () => {
  const result = calculate(bank.questions[86].question);
  assert.ok(result.missing.includes('income_change'));
  assert.equal(result.values.income, undefined);
});

test('generic current savings targets select a recorded goal and goal costs retain their financial purpose', () => {
  assert.ok(calculate(bank.questions[38].question).missing.includes('goal_selection'));
  assert.match(calculate(bank.questions[64].question).content, /printing, supplies or enrollment cost/);
  assert.match(calculate(bank.questions[87].question).content, /total bill amount/);
});

test('new loans request a new principal and priorities request comparison terms before choosing a debt', () => {
  assert.ok(calculate(bank.questions[97].question).missing.includes('debt_principal'));
  const priority = calculate(bank.questions[95].question);
  assert.deepEqual(priority.missing, ['priority_terms']);
  assert.equal(priority.values.periods, undefined);
  assert.match(priority.content, /interest rate, fees and minimum payment/);
});

test('which goals can finish uses each recorded pace and asks for dates rather than demanding a new shared budget', () => {
  const result = calculate(bank.questions[37].question);
  assert.ok(result.missing.includes('contribution_dates'));
  assert.ok(!result.missing.includes('shared_surplus'));
  assert.match(result.content, /Laptop.*10 contributions needed/);
  const facts = completeFacts(), first = localFinancialPlan(bank.questions[37].question, facts)!;
  const next = calculate('first contribution date: 2026-10-15', facts, context(first));
  assert.deepEqual(next.missing, []);
  assert.equal(next.values.contributions, 3);
  assert.equal(next.values.achievableGoals, 'None');
});

test('selecting a missing goal keeps the stated earlier-deadline and skip-saving question', () => {
  const facts = completeFacts();
  const original = localFinancialPlan(bank.questions[34].question, facts)!;
  const earlier = calculate('Laptop', facts, context(original));
  assert.equal(earlier.values.required, 5000);
  const skip = localFinancialPlan(bank.questions[35].question, facts)!;
  assert.equal(calculate('Laptop', facts, context(skip)).values.periodsSaved, -1);
});

test('a practical-change question offers a relevant action and a small-purchases question states its evidence limit', () => {
  assert.match(calculate(bank.questions[148].question).content, /One practical step this week:/);
  assert.match(calculate(bank.questions[142].question).content, /totals alone do not show which purchases were small/);
});

test('a new skipped-saving question does not reuse the bonus from an earlier what-if calculation', () => {
  const facts = completeFacts(), bonus = localFinancialPlan('If I receive a ₱5000 bonus, how much closer will I be to my Laptop goal?', facts)!;
  const skip = calculate('If I skip saving this month, how much will my Laptop goal be delayed?', facts, context(bonus));
  assert.equal(skip.values.remaining, 40000);
  assert.equal(skip.values.periods, 10);
  assert.equal(skip.values.periodsSaved, -1);
});

test('model extraction cannot reassign school-food costs to allowance, drop category filters or change supported question roles', () => {
  const facts = completeFacts(), school = localFinancialPlan(bank.questions[66].question, facts)!;
  assert.throws(() => verifyExtractedPlan({ ...school, income: 150 }, bank.questions[66].question, school), /CONFLICTING_ALLOWANCE_INPUT/);
  const delivery = localFinancialPlan(bank.questions[139].question, facts)!;
  assert.throws(() => verifyExtractedPlan({ ...delivery, category: 'Transport' }, bank.questions[139].question, delivery), /CONFLICTING_PLANNING_INPUT/);
  const cheaper = localFinancialPlan(bank.questions[12].question, facts)!;
  assert.throws(() => verifyExtractedPlan({ ...cheaper, goalMode: 'build_savings' }, bank.questions[12].question, cheaper), /CONFLICTING_PLANNING_INPUT/);
  const earlier = localFinancialPlan('How much more do I need to save monthly for my Laptop goal to finish two months earlier?', facts)!;
  assert.throws(() => verifyExtractedPlan({ ...earlier, periods: 2 }, 'finish two months earlier', earlier), /UNSUPPORTED_PLANNING_COUNT_OR_SELECTION/);
});

test('an exceeded budget reports the shortfall rather than describing a negative balance as within the limit', () => {
  const facts = completeFacts(); facts.budget = {target:5000,spent:27000};
  const result = calculate('Is my current budget realistic based on my actual expenses?', facts);
  assert.equal(result.values.remaining, -22000);
  assert.match(result.content, /exceeding the limit by ₱22,000.00/);
  assert.doesNotMatch(result.content, /within the limit/);
});

test('structured follow-ups validate all fields before retaining the previous operation', () => {
  assert.equal(isStructuredPlanningReply('Details: {"newSaving":2000}'), true);
  assert.equal(isStructuredPlanningReply('Details: {}'), true);
  for (const text of ['Details: {"newSaving":-1}', 'Details: {"owner":"another-user"}', 'Details: {"target":1.001}', 'Details: {"action":"PAY_BILL"}', 'Details: {"from":"2026-02-30"}', 'Details: {']) assert.equal(isStructuredPlanningReply(text), false);
});

test('a live provider cannot turn an increase by 500 into a total monthly contribution of 500', async () => {
  const message = bank.questions[43].question, facts = completeFacts();
  const local = localFinancialPlan(message, facts)!;
  assert.equal(local.delta, 500);
  const wrong = { operation: 'goal_change', language: 'en', contribution: 500 };
  assert.throws(() => verifyExtractedPlan(wrong, message, local), /CONFLICTING_AMOUNT_ROLE/);
  const provider = { reserve: async () => {}, generate: async () => {
    const response = new GenerateContentResponse();
    response.candidates = [{ content: { role: 'model', parts: [{ text: JSON.stringify(wrong) }] } }];
    return response;
  }, response: offline };
  const first = await answerFinancialPlan(message, facts, 'review-owner', [], provider);
  assert.ok(first);
  assert.equal(first.context.plan.contribution, undefined);
  assert.equal(first.context.plan.delta, 500);
  assert.doesNotMatch(first.content, /Planned contribution: ₱500/);
  const selected = await answerFinancialPlan('Laptop', facts, 'review-owner',
    [{ question: message, answer: first.content, pendingAction: first.context }], provider);
  assert.ok(selected);
  assert.equal(selected.result.values.contribution, 4500);
  assert.equal(selected.result.values.periods, 9);
  assert.equal(selected.result.values.baselinePeriods, 10);
  const dated = calculate('first contribution date: 2026-10-15', facts, selected.context);
  assert.equal(dated.values.completionDate, '2027-06-15');
});

test('a labeled base contribution and a separately stated increase retain their distinct amounts', () => {
  const message = 'Current monthly contribution: ₱4000. If I increase my monthly savings by ₱500, when will I finish my Laptop goal?';
  const local = localFinancialPlan(message, completeFacts())!;
  assert.equal(local.contribution, 4000);
  assert.equal(local.delta, 500);
  const result = executeFinancialPlan(local, completeFacts());
  assert.equal(result.values.contribution, 4500);
  assert.equal(result.values.periods, 9);
});
