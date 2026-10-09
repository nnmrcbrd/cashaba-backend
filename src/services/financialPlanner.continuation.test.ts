import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import { completeFacts } from '@/evaluation/planningFixtures';
import type { PlanningContext } from '@/utils/financialPlanner';
import { answerFinancialPlan, localFinancialPlan } from './financialPlanner';
import { statedGoalInputs } from '@/utils/planningInputs';

const originalQuestion = 'how long will it take for me to buy the latest iphone 18 pro max?';
const priceReply = 'iphone 18 pro max 2TB: ₱194,990.00';
const context = (plan: PlanningContext['plan']): PlanningContext => ({ kind: 'FINANCIAL_PLAN_V1', owner: 'owner-a', updatedAt: new Date().toISOString(), plan });
const offline = { reserve: async () => {}, generate: async (): Promise<GenerateContentResponse> => { throw { status: 403 }; } };
const generated = (operation: string) => ({ reserve: async () => {}, generate: async () => ({ text: JSON.stringify({ operation, language: 'en' }) }) as GenerateContentResponse });
const screenshotFacts = () => {
  const facts = completeFacts();
  facts.breakdown = { ...facts.breakdown, actualIncome: 0, totalIncome: 0, totalExpenses: 1500, totalFixed: 2999,
    totalLoanRepayments: 500, totalSavings: 1000, rawSafeToSpend: -5999, safeToSpend: 0 };
  facts.budget = { target: 5000, spent: 1500 };
  return facts;
};

test('the exact product and capacity reply fills the pending target locally', () => {
  const first = localFinancialPlan(originalQuestion, screenshotFacts())!;
  const next = localFinancialPlan(priceReply, screenshotFacts(), context(first))!;
  assert.equal(next.operation, 'goal_timeline');
  assert.equal(next.target, 194990);
  assert.equal(next.saved, undefined);
});

test('a generated budget review cannot replace the pending price clarification', async () => {
  const facts = screenshotFacts();
  const first = await answerFinancialPlan(originalQuestion, facts, 'owner-a', [], offline);
  assert.ok(first);
  let calls = 0;
  const wrongModel = generated('budget_review');
  const next = await answerFinancialPlan(priceReply, facts, 'owner-a', [
    { question: originalQuestion, answer: first.content, pendingAction: first.context },
  ], { ...wrongModel, generate: async () => { calls++; return wrongModel.generate(); } });
  assert.equal(calls, 0, 'A clear answer to the price question must not be reclassified by the model');
  assert.equal(next?.result.operation, 'goal_timeline');
  assert.equal(next?.context.plan.target, 194990);
  assert.ok(next?.result.missing.includes('saved_balance'));
  assert.match(next!.content, /Target: ₱194,990\.00/);
  assert.match(next!.content, /How much is already saved specifically for this target/);
  assert.doesNotMatch(next!.content, /Month-to-date spending|within the limit/);
  assert.equal(next?.result.values.receivedIncome, 0);
  assert.equal(next?.result.values.recordedSpending, 1500);
});

test('named product prices distinguish model and storage numbers from the monetary price', () => {
  assert.equal(statedGoalInputs(priceReply).target, 194990);
  assert.equal(statedGoalInputs('Galaxy S26 Ultra 1TB: PHP 89990').target, 89990);
  assert.equal(statedGoalInputs('iPhone 18 Pro Max 2TB').target, undefined);
  for (const label of ['current savings', 'allocated savings', 'income', 'monthly budget', 'Rent', 'debt payment', 'Emergency Fund']) {
    assert.equal(statedGoalInputs(`${label}: ₱1000`).target, undefined, label);
  }
});

test('an existing chat with the wrong budget answer recovers the price and continues the savings plan', async () => {
  const original = context({ operation: 'goal_timeline', language: 'en' });
  const wrong = context({ operation: 'budget_review', language: 'en' });
  const history = [
    { question: originalQuestion, answer: 'What is the target price in PHP?', pendingAction: original },
    { question: priceReply, answer: 'Month-to-date spending is ₱1,500.00 against ₱5,000.00.', pendingAction: wrong },
  ];
  const before = JSON.stringify(history);
  const retried = await answerFinancialPlan(priceReply, screenshotFacts(), 'owner-a', history, generated('budget_review'));
  assert.equal(retried?.result.operation, 'goal_timeline');
  assert.equal(retried?.context.plan.target, 194990);
  assert.ok(retried?.result.missing.includes('saved_balance'));
  const answer = await answerFinancialPlan('I havent saved anything yet, allocated savings: 1000 monthly', screenshotFacts(), 'owner-a', history, generated('budget_review'));
  assert.equal(answer?.context.plan.target, 194990);
  assert.equal(answer?.context.plan.saved, 0);
  assert.equal(answer?.context.plan.contribution, 1000);
  assert.equal(answer?.result.values.periods, 195);
  assert.equal(answer?.result.values.receivedIncome, 0);
  assert.equal(JSON.stringify(history), before, 'Recovery must not rewrite saved history or the caller records');
});

test('an explicit request to review the budget starts the requested budget review', async () => {
  const answer = await answerFinancialPlan('Review my budget', screenshotFacts(), 'owner-a', [
    { question: originalQuestion, answer: 'What is the price?', pendingAction: context({ operation: 'goal_timeline', language: 'en' }) },
  ], generated('budget_review'));
  assert.equal(answer?.result.operation, 'budget_review');
  assert.equal(answer?.result.values.target, 5000);
  assert.equal(answer?.result.values.spent, 1500);
  assert.equal(answer?.context.plan.target, undefined);
});

test('cancelled, expired and other-owner goal contexts cannot repair a price reply', async () => {
  const wrong = context({ operation: 'budget_review', language: 'en' });
  const original = context({ operation: 'goal_timeline', language: 'en' });
  for (const prefix of [
    [{ question: originalQuestion, answer: 'Price?', pendingAction: { ...original, owner: 'owner-b' } }],
    [{ question: originalQuestion, answer: 'Price?', pendingAction: { ...original, updatedAt: new Date(Date.now() - 31 * 60000).toISOString() } }],
    [{ question: originalQuestion, answer: 'Price?', pendingAction: original }, { question: 'start over', answer: 'Cancelled', pendingAction: null }],
  ]) {
    const answer = await answerFinancialPlan('I havent saved anything yet', screenshotFacts(), 'owner-a', [
      ...prefix, { question: priceReply, answer: 'Budget review', pendingAction: wrong },
    ], offline);
    assert.equal(answer?.context.plan.target, undefined);
    assert.equal(answer?.result.values.periods, undefined);
  }
});

test('the exact comma contribution reply bypasses conflicting model extraction', async () => {
  let calls = 0;
  const answer = await answerFinancialPlan('1000, EVERY MONTH', screenshotFacts(), 'owner-a', [
    { question: 'I HAVENT SAVE ANYTHING YET', answer: 'How much per contribution and how often?',
      pendingAction: context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 0 }) },
  ], { reserve: async () => {}, generate: async () => { calls++; return { text: '{"operation":"budget_review","language":"en"}' } as GenerateContentResponse; } });
  assert.equal(calls, 0);
  assert.equal(answer?.context.plan.contribution, 1000);
  assert.equal(answer?.context.plan.frequency, 'monthly');
  assert.equal(answer?.result.values.periods, 195);
  assert.equal(answer?.requiresClarification, false);
});

test('an existing repeated-question chat recovers its ignored comma contribution', async () => {
  const history = [
    { question: priceReply, answer: 'How much is saved?', pendingAction: context({ operation: 'goal_timeline', language: 'en', target: 194990 }) },
    { question: 'I HAVENT SAVE ANYTHING YET', answer: 'How much per contribution and how often?', pendingAction: context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 0 }) },
    { question: '1000, EVERY MONTH', answer: 'How much per contribution and how often?', pendingAction: context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 0 }) },
  ];
  const original = JSON.stringify(history);
  const answer = await answerFinancialPlan('every month', screenshotFacts(), 'owner-a', history, offline);
  assert.equal(answer?.result.values.periods, 195);
  assert.equal(answer?.context.plan.target, 194990);
  assert.equal(answer?.context.plan.saved, 0);
  assert.equal(answer?.context.plan.contribution, 1000);
  assert.equal(answer?.context.plan.frequency, 'monthly');
  assert.equal(JSON.stringify(history), original);
});
