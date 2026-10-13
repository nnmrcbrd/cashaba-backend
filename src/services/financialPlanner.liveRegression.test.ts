import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import bank from '@/evaluation/aiQuestions.v1.json';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan } from '@/utils/financialPlanner';
import { explicitPlanningInputs } from '@/utils/planningExplicitInputs';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from './financialPlanner';

test('all original questions retain their intended tool with complete explicit scenario details', () => {
  const failures: unknown[] = [];
  for (const row of bank.questions) {
    const inputs = Object.fromEntries(Object.entries(row.completeInput).filter(([key]) => !['operation', 'language'].includes(key)));
    for (const label of ['Scenario', 'Explicit hypothetical scenario details (not changes to my records)']) {
      const message = `${row.question}\n${label}: ${JSON.stringify(inputs)}`;
      const facts = completeFacts(), before = JSON.stringify(facts);
      const plan = localFinancialPlan(message, facts);
      const result = plan ? executeFinancialPlan(plan, facts) : null;
      const wrong = Object.entries(row.expected).filter(([key, value]) => result?.values[key] !== value);
      if (plan?.operation !== row.completeInput.operation || result?.missing.length || wrong.length) {
        failures.push({ id: row.id, label, expected: row.completeInput.operation, actual: plan?.operation, missing: result?.missing, wrong });
      }
      assert.equal(JSON.stringify(facts), before);
    }
  }
  assert.deepEqual(failures, []);
});

test('all original incomplete questions choose the relevant tool without claiming unsupported affordability', () => {
  const failures: unknown[] = [];
  for (const row of bank.questions) {
    const plan = localFinancialPlan(row.question, missingFacts());
    const result = plan ? executeFinancialPlan(plan, missingFacts()) : null;
    if (plan?.operation !== row.completeInput.operation) failures.push({ id: row.id, expected: row.completeInput.operation, actual: plan?.operation });
    assert.equal(result?.values.affordable, undefined, row.question);
    assert.equal(result?.values.completionDate, undefined, row.question);
  }
  assert.deepEqual(failures, []);
});

test('a conflicting model operation cannot turn maximum cash into income allocation', () => {
  for (const question of ['What travel budget can I afford without delaying my bills?', 'What phone budget can I afford without using my emergency savings?', 'What is the maximum amount I can spend on a birthday gift this month?']) {
    const local = localFinancialPlan(question, completeFacts())!;
    assert.equal(local.operation, 'cash_available');
    assert.throws(() => verifyExtractedPlan({ operation: 'budget_allocate', language: 'en' }, question, local), /CONFLICTING_PLANNING_OPERATION/);
  }
});

test('natural start dates, zero saved and contribution periods survive model omissions', () => {
  const question = 'If I save PHP 100 every day, when will I reach PHP 20000? Saved: 0. First contribution on 2026-10-09.';
  const local = localFinancialPlan(question, completeFacts())!;
  const plan = verifyExtractedPlan({ operation: 'goal_timeline', language: 'en', target: 20000, contribution: 100 }, question, local);
  assert.equal(plan.saved, 0);
  assert.deepEqual(plan.schedule, { frequency: 'daily', first: '2026-10-09' });
  assert.equal(executeFinancialPlan(plan, completeFacts()).values.completionDate, '2027-04-26');
  const deadline = 'Can I buy a gaming PC worth PHP 60000 within one year? Saved: 0, 12 monthly contributions.';
  const contributionPlan = localFinancialPlan(deadline, completeFacts())!;
  assert.equal(contributionPlan.periods, 12);
  assert.equal(executeFinancialPlan(contributionPlan, completeFacts()).values.required, 5000);
});

test('supplied nested fields and dates cannot be dropped or changed by generated extraction', async () => {
  const message = 'How long to save for my goal?\nPlanning inputs: {"target":20000,"saved":0,"contribution":100,"frequency":"daily","schedule":{"frequency":"daily","first":"2026-10-09"}}';
  const local = localFinancialPlan(message, completeFacts())!;
  const sparse = verifyExtractedPlan({ operation: 'goal_timeline', language: 'en' }, message, local);
  assert.equal(executeFinancialPlan(sparse, completeFacts()).values.completionDate, '2027-04-26');
  assert.throws(() => verifyExtractedPlan({ ...local, schedule: { frequency: 'daily', first: '2026-10-10' } }, message, local), /CONFLICTING_PLANNING_INPUT/);
  const result = await answerFinancialPlan(message, completeFacts(), 'owner-a', [], {
    reserve: async () => {}, generate: async () => ({ text: '{"operation":"goal_timeline","language":"en"}' }) as GenerateContentResponse,
  });
  assert.equal(result?.result.values.completionDate, '2027-04-26');
  assert.equal(result?.requiresClarification, false);
});

test('scenario inputs reject invalid dates, amounts and privileged/action fields', () => {
  for (const data of [{ target: -100 }, { target: 0.001 }, { schedule: { frequency: 'daily', first: '2026-02-30' } }, { owner: 'other', target: 100 }, { operation: 'TRANSFER', purchase: 100 }, { userId: 'other', saved: 0 }, { periods: 0 }]) {
    assert.deepEqual(explicitPlanningInputs(`Planning inputs: ${JSON.stringify(data)}`), {});
  }
});

test('malformed provider JSON preserves all explicit nested schedule inputs', async () => {
  const message = 'If I save ₱100 every day, when will I reach ₱20,000?\nExplicit hypothetical scenario details (not changes to my records): {"target":20000,"saved":0,"contribution":100,"frequency":"daily","schedule":{"frequency":"daily","first":"2026-10-09"}}';
  const answer = await answerFinancialPlan(message, completeFacts(), 'owner-a', [], {
    reserve: async () => {},
    // Gemini's observed response supplied daily as raw text instead of the
    // required JSON-encoded string. This must never discard the user's inputs.
    generate: async () => ({ text: JSON.stringify({ operation: 'goal_timeline', language: 'en',
      parameters: [{ field: 'frequency', valueJson: 'daily' }] }) }) as GenerateContentResponse,
  });
  assert.equal(answer?.requiresClarification, false);
  assert.equal(answer?.context.plan.saved, 0);
  assert.equal(answer?.result.values.periods, 200);
  assert.equal(answer?.result.values.completionDate, '2027-04-26');
  assert.doesNotMatch(answer?.content ?? '', /How much is already saved/);
});

test('cash duration and affordable monthly saving paraphrases keep their cash meaning', async () => {
  for (const question of ['How long will my cash last until the next payday?', 'What daily spending limit is safe until my next income?']) {
    assert.equal(localFinancialPlan(question, completeFacts())?.operation, 'daily_limit');
  }
  assert.equal(localFinancialPlan('How much can I safely save monthly after paying my bills?', completeFacts())?.operation, 'cash_available');
  const previous = { kind: 'FINANCIAL_PLAN_V1' as const, owner: 'owner-a', updatedAt: new Date().toISOString(),
    plan: { operation: 'goal_timeline' as const, language: 'en' as const, target: 300, saved: 0, contribution: 100, frequency: 'weekly' as const } };
  const plan = localFinancialPlan('Start on 2026-10-09', completeFacts(), previous)!;
  assert.equal(executeFinancialPlan(plan, completeFacts()).values.completionDate, '2026-10-23');
  let calls = 0;
  const answer = await answerFinancialPlan('Start on 2026-10-09', completeFacts(), 'owner-a', [
    { question: 'Save 100 weekly', answer: 'Three contributions', pendingAction: previous },
  ], { reserve: async () => {}, generate: async () => { calls++; return { text: '{"operation":"budget_review","language":"en"}' } as GenerateContentResponse; } });
  assert.equal(calls, 0);
  assert.equal(answer?.result.values.completionDate, '2026-10-23');
});
