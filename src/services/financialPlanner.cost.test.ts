import test from 'node:test';
import assert from 'node:assert/strict';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import bank from '@/evaluation/aiQuestions.v1.json';
import { scenarios } from '@/evaluation/questionScenarios';
import { executeFinancialPlan, type PlanningContext } from '@/utils/financialPlanner';
import { localFinancialPlan, verifyExtractedPlan } from './financialPlanner';

test('regenerating the three corrected cost scenarios preserves the reviewed intent and expected amounts', () => {
  for (const id of [128, 133, 134]) {
    const row = bank.questions.find(row => row.id === id)!;
    const generated = scenarios.find(row => row.id === id)!;
    assert.deepEqual(generated.completeInput, row.completeInput);
    assert.deepEqual(generated.expected, row.expected);
    assert.equal(generated.intent, row.intent);
  }
});

test('rental savings uses the supplied full move-in total without inventing a second option', () => {
  const message = 'How much should I save before moving into a rental, including deposits and basic furniture? Full move-in cost: PHP 30,000.';
  const local = localFinancialPlan(message, completeFacts())!;
  assert.equal(local.costMode, 'total');
  const result = executeFinancialPlan(local, completeFacts());
  assert.equal(result.values.fullCost, 30000);
  assert.deepEqual(result.missing, []);
  assert.match(result.content, /amount to set aside/);
  assert.doesNotMatch(result.content, /alternative|costs.*more/);
  assert.throws(() => verifyExtractedPlan({ ...local, costMode: 'comparison' }, message, local), /CONFLICTING_COST_INTENT/);
  const sparse = verifyExtractedPlan({ operation: 'cost_plan', language: 'en' }, message, local);
  assert.equal(sparse.costMode, 'total');
  assert.equal(sparse.target, 30000);
});

test('rental missing information and a bare follow-up ask only for the full cost', () => {
  const question = 'How much should I save before moving into a rental, including deposits and basic furniture?';
  const plan = localFinancialPlan(question, missingFacts())!;
  assert.deepEqual(executeFinancialPlan(plan, missingFacts()).missing, ['full_cost']);
  const previous: PlanningContext = { kind: 'FINANCIAL_PLAN_V1', owner: 'owner-a', updatedAt: new Date().toISOString(), plan };
  const follow = localFinancialPlan('30000', missingFacts(), previous)!;
  assert.equal(follow.target, 30000);
  assert.equal(follow.costMode, 'total');
  assert.deepEqual(executeFinancialPlan(follow, missingFacts()).missing, []);
});

test('rental total-cost paraphrases preserve the requested amount to save', () => {
  for (const question of ['How much should I save before moving into a rental?', 'How much should I set aside before I move into an apartment?', 'What is the full move-in cost?']) {
    const plan = localFinancialPlan(question, missingFacts());
    assert.ok(plan, question);
    assert.equal(plan.operation, 'cost_plan', question);
    assert.equal(plan.costMode, 'total', question);
    assert.deepEqual(executeFinancialPlan(plan, missingFacts()).missing, ['full_cost']);
  }
});

test('cheaper transport cannot hide a larger salary reduction or invent a new income', () => {
  const message = 'Can I afford to take a lower-paying job with cheaper transportation costs? Current income: PHP 30,000; new income: PHP 25,000; new full costs: PHP 25,000; current full costs: PHP 28,000.';
  const facts = completeFacts(), before = JSON.stringify(facts);
  const plan = localFinancialPlan(message, facts)!;
  const result = executeFinancialPlan(plan, facts);
  assert.equal(plan.costMode, 'income_effect');
  assert.deepEqual(result.missing, []);
  assert.equal(result.values.difference, -3000);
  assert.equal(result.values.netEffect, -2000);
  assert.equal(result.values.baselineRemaining, 2000);
  assert.equal(result.values.remaining, 0);
  assert.match(result.content, /₱2,000\.00 less remaining/);
  assert.equal(result.values.affordable, undefined);
  assert.equal(JSON.stringify(facts), before);
  const { income: _income, newIncome: _newIncome, ...costsOnly } = plan;
  assert.deepEqual(executeFinancialPlan(costsOnly, facts).missing, ['scenario_income', 'new_income']);
});

test('business budget impact includes its costs without assuming future business revenue', () => {
  const message = 'How will starting a small business affect my personal budget?\nPlanning inputs: {"target":30000,"alternativeCost":10000,"income":30000,"newIncome":30000}';
  const plan = localFinancialPlan(message, completeFacts())!;
  const result = executeFinancialPlan(plan, completeFacts());
  assert.equal(plan.costMode, 'income_effect');
  assert.equal(result.values.netEffect, -20000);
  assert.equal(result.values.remaining, 0);
  assert.match(result.content, /one-time startup costs separate/);
  assert.deepEqual(executeFinancialPlan({ ...plan, newIncome: undefined }, completeFacts()).missing, ['new_income']);
});

test('cost comparisons state more, less or equal without a negative amount described as more', () => {
  for (const [target, alternativeCost, expected] of [[100.01, 90, /₱10\.01 more/], [90, 100.01, /₱10\.01 less/], [90, 90, /same supplied cost/]] as const) {
    const result = executeFinancialPlan({ operation: 'cost_plan', language: 'en', target, alternativeCost }, completeFacts());
    assert.match(result.content, expected);
    assert.doesNotMatch(result.content, /-₱.*more/);
  }
});

test('conflicting or negative new income requires clarification rather than a net-effect answer', () => {
  const base = { operation: 'cost_plan' as const, language: 'en' as const, costMode: 'income_effect' as const, income: 30000, target: 25000, alternativeCost: 28000 };
  for (const extra of [{ newIncome: 28000, incomeDelta: -5000 }, { incomeDelta: -35000 }]) {
    const result = executeFinancialPlan({ ...base, ...extra }, completeFacts());
    assert.ok(result.missing.includes('new_income'));
    assert.equal(result.values.netEffect, undefined);
  }
});

test('job comparison reports a deficit and accepts a stated salary reduction in whole centavos', () => {
  const result = executeFinancialPlan({ operation: 'cost_plan', language: 'en', costMode: 'income_effect',
    income: 30000, incomeDelta: -5000, target: 32000, alternativeCost: 28000 }, completeFacts());
  assert.deepEqual(result.missing, []);
  assert.equal(result.values.newIncome, 25000);
  assert.equal(result.values.remaining, -7000);
  assert.equal(result.values.netEffect, -9000);
  assert.match(result.content, /-₱7,000\.00/);
  assert.equal(result.values.affordable, undefined);
});
