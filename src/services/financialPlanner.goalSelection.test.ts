import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan } from '@/utils/financialPlanner';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from './financialPlanner';

const question = 'How much should I set aside weekly for printing and school supplies?';
const purposeAsGoal = (complete = false) => ({
  reserve: async () => {},
  // Replay the actual live extraction shape; no provider or database is called.
  generate: async () => ({ text: JSON.stringify({ operation: 'goal_contribution', language: 'en',
    parameters: [
      ...(complete ? [{ field: 'target', valueJson: '1000' }, { field: 'saved', valueJson: '0' }, { field: 'periods', valueJson: '4' }] : []),
      { field: 'frequency', valueJson: '"weekly"' },
      { field: 'goalNames', valueJson: '["printing and school supplies"]' },
    ],
  }) }) as GenerateContentResponse,
});

test('a stated school-cost purpose cannot block a complete hypothetical weekly allocation', async () => {
  const facts = completeFacts(), before = JSON.stringify(facts);
  const message = question + '\nExplicit hypothetical scenario details (not changes to my records): {"target":1000,"saved":0,"periods":4}';
  const answer = await answerFinancialPlan(message, facts, 'synthetic-owner', [], purposeAsGoal(true));
  assert.ok(answer);
  assert.equal(answer.result.values.required, 250);
  assert.equal(answer.result.values.contributions, 4);
  assert.equal(answer.requiresClarification, false);
  assert.equal(answer.context.plan.goalNames, undefined);
  assert.doesNotMatch(answer.content, /Which recorded goal/);
  assert.equal(JSON.stringify(facts), before);
});

test('school-purpose questions ask for costs and dates rather than an invented recorded goal', async () => {
  for (const facts of [completeFacts(), missingFacts()]) {
    const answer = await answerFinancialPlan(question, facts, 'synthetic-owner', [], purposeAsGoal());
    assert.ok(answer);
    assert.deepEqual(answer.result.missing, ['target_price', 'saved_balance', 'contribution_dates']);
    assert.equal(answer.context.plan.goalNames, undefined);
    assert.match(answer.content, /What total printing, supplies or enrollment cost/);
    assert.doesNotMatch(answer.content, /Which recorded goal/);
  }
});

test('an actual selected saved goal remains usable and case-insensitive', () => {
  const facts = completeFacts();
  const message = 'How much should I save weekly for my Laptop goal?\nPlanning inputs: {"periods":4}';
  const local = localFinancialPlan(message, facts)!;
  assert.deepEqual(local.goalNames, ['Laptop']);
  const plan = verifyExtractedPlan({ ...local, goalNames: ['laptop'] }, message, local);
  assert.equal(executeFinancialPlan(plan, facts).values.required, 10000);
});

test('provider extraction cannot silently drop one of the user-selected goals', () => {
  const message = 'Can I afford both Laptop and Phone?';
  const local = localFinancialPlan(message, completeFacts())!;
  assert.deepEqual(local.goalNames, ['Laptop', 'Phone']);
  assert.throws(() => verifyExtractedPlan({ ...local, goalNames: ['Phone'] }, message, local), /UNSUPPORTED_GOAL_SELECTION/);
});

test('complete school-supplies details also work in an ordinary single-line chat message', async () => {
  for (const separator of [' ', '  ', '\t']) {
    const facts = completeFacts(), before = JSON.stringify(facts);
    const message = question + separator + 'Explicit hypothetical scenario details (not changes to my records): {"target":1000,"saved":0,"periods":4}';
    const local = localFinancialPlan(message, facts)!;
    assert.equal(local.operation, 'goal_contribution');
    assert.equal(local.target, 1000);
    assert.equal(local.saved, 0);
    assert.equal(local.periods, 4);
    const answer = await answerFinancialPlan(message, facts, 'synthetic-owner', [], purposeAsGoal(true));
    assert.ok(answer);
    assert.equal(answer.result.values.required, 250);
    assert.equal(answer.result.values.contributions, 4);
    assert.equal(answer.requiresClarification, false);
    assert.doesNotMatch(answer.content, /What total printing|Which recorded goal/);
    assert.equal(JSON.stringify(facts), before);
  }
});
test('natural-language contribution counts cannot create a fictitious current saving rate', async () => {
  const facts = completeFacts();
  const message = question + ' The target costs ₱1,000. I have saved ₱0. I have 4 weekly contributions left. This is hypothetical; do not change any financial records.';
  const local = localFinancialPlan(message, facts)!;
  assert.equal(local.periods, 4);
  assert.equal(local.contribution, undefined);
  const answer = await answerFinancialPlan(message, facts, 'synthetic-owner', [], purposeAsGoal());
  assert.ok(answer);
  assert.equal(answer.result.values.required, 250);
  assert.equal(answer.result.values.contributions, 4);
  assert.equal(answer.requiresClarification, false);
  assert.doesNotMatch(answer.content, /Planned contribution:|above the current contribution/);
});