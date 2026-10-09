import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan, type PlanningContext } from '@/utils/financialPlanner';
import { statedGoalInputs } from '@/utils/planningInputs';
import { coreReply } from '@/utils/coreConversation';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from './financialPlanner';

const offline = { reserve: async () => {}, generate: async (): Promise<GenerateContentResponse> => { throw { status: 403 }; } };
const context = (plan: PlanningContext['plan']): PlanningContext => ({ kind: 'FINANCIAL_PLAN_V1', owner: 'owner-a', updatedAt: new Date().toISOString(), plan });

test('screenshot conversation retains price, accepts labeled savings, and understands nothing saved without Gemini', async () => {
  const facts = completeFacts(), before = JSON.stringify(facts);
  const history: Array<{ question: string; answer: string; pendingAction: PlanningContext }> = [];
  const turn = async (question: string) => {
    const answer = await answerFinancialPlan(question, facts, 'owner-a', history, offline);
    assert.ok(answer);
    history.push({ question, answer: answer.content, pendingAction: answer.context });
    return answer;
  };
  const first = await turn('how long will it take for me to buy the latest iphone 18 pro max?');
  assert.ok(first.result.missing.includes('target_price'));
  assert.equal(first.result.values.saved, undefined, 'Do not use an unrelated Phone or Emergency goal');
  assert.match(first.content, /30,000\.00 received/);
  assert.doesNotMatch(first.content, /I need What|I need How|Also needed:|Snapshot:/);

  const second = await turn('₱194,990.00, iphone 18 pro max, allocated savings: 1000');
  assert.equal(second.context.plan.target, 194990);
  assert.equal(second.context.plan.contribution, 1000);
  assert.equal(second.context.plan.saved, undefined);
  assert.deepEqual(second.result.missing, ['saved_balance']);
  assert.match(second.content, /Planned contribution: ₱1,000\.00/);

  const third = await turn('i havent save anything yet');
  assert.equal(third.context.plan.target, 194990);
  assert.equal(third.context.plan.saved, 0);
  assert.deepEqual(third.result.missing, []);
  assert.equal(third.result.values.contribution, 1000);
  assert.equal(third.result.values.periods, 195);
  assert.equal(third.result.values.remaining, 194990);
  assert.match(third.content, /Saved for this target: ₱0\.00/);
  assert.doesNotMatch(third.content, /How much is already saved/);
  assert.equal(third.result.values.receivedIncome, 30000);
  assert.equal(third.result.values.recordedSpending, 5100);
  assert.equal(third.result.values.periodSafeToSpend, 18400);

  const fourth = await turn('monthly');
  assert.deepEqual(fourth.result.missing, []);
  assert.equal(fourth.result.values.periods, 195);
  assert.equal(fourth.context.plan.frequency, 'monthly');
  assert.match(fourth.content, /195 monthly contribution\(s\).*16 year\(s\) and 3 month\(s\)/);
  assert.equal(fourth.result.values.completionDate, null);
  assert.equal(JSON.stringify(facts), before, 'Planning must not change the user ledger');
});

test('saved balance and recurring savings labels keep their different meanings', () => {
  assert.deepEqual(statedGoalInputs('allocated savings: 1000'), { contribution: 1000 });
  assert.deepEqual(statedGoalInputs('monthly allocated savings: 1000'), { contribution: 1000, frequency: 'monthly' });
  assert.deepEqual(statedGoalInputs('monthly allocation: 1000'), { contribution: 1000, frequency: 'monthly' });
  assert.deepEqual(statedGoalInputs('current savings: ₱1,000.50; contribution: 250 per week'), { saved: 1000.5, contribution: 250, frequency: 'weekly' });
  assert.deepEqual(statedGoalInputs('price: 194990; saved: 0; 1000 monthly'), { target: 194990, saved: 0, contribution: 1000, frequency: 'monthly' });
});

test('explicit no-savings statements mean zero, while missing records stay unknown', () => {
  for (const message of ["I haven't saved anything yet", 'I have not saved any money yet', 'i havent save anything yet', 'saved nothing yet', 'nothing saved yet', 'savings is zero', 'no savings yet', 'wala pa akong ipon', 'wala pa koy natigom']) {
    assert.equal(statedGoalInputs(message).saved, 0, message);
  }
  const unknown = executeFinancialPlan({ operation: 'goal_timeline', target: 194990 }, missingFacts());
  assert.equal(unknown.values.saved, undefined);
  assert.ok(unknown.missing.includes('saved_balance'));
  assert.match(unknown.content, /No received income or spending is recorded/);
});

test('a contribution or saved amount with a PHP prefix does not overwrite the target', () => {
  const previous = context({ operation: 'goal_timeline', language: 'en', target: 194990 });
  const withSaved = localFinancialPlan('current savings: PHP 1000', completeFacts(), previous)!;
  assert.equal(withSaved.target, 194990);
  assert.equal(withSaved.saved, 1000);
  const withContribution = localFinancialPlan('PHP 2000 per month', completeFacts(), context(withSaved))!;
  assert.equal(withContribution.target, 194990);
  assert.equal(withContribution.contribution, 2000);
  assert.equal(withContribution.frequency, 'monthly');
  assert.equal(executeFinancialPlan(withContribution, completeFacts()).values.periods, 97);
});

test('corrections also update a completed scenario', () => {
  const previous = context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 1000, contribution: 1000, frequency: 'monthly' });
  const plan = localFinancialPlan("Actually I haven't saved anything yet", completeFacts(), previous)!;
  assert.equal(plan.saved, 0);
  assert.equal(plan.target, 194990);
  assert.equal(executeFinancialPlan(plan, completeFacts()).values.periods, 195);
});

test('model extraction cannot undo an explicit zero or swap a savings amount into price', () => {
  const local = { operation: 'goal_timeline' as const, language: 'en' as const, target: 194990, saved: 0 };
  assert.throws(() => verifyExtractedPlan({ ...local, saved: 1000 }, 'i havent save anything yet', local), /CONFLICTING_PLANNING_INPUT/);
  assert.throws(() => verifyExtractedPlan({ ...local, operation: 'budget_review' }, 'i havent save anything yet', local), /CONFLICTING_PLANNING_OPERATION/);
  assert.throws(() => verifyExtractedPlan({ ...local, contribution: 1000, target: 1000 }, 'allocated savings: 1000', { ...local, contribution: 1000 }), /SAVINGS_IS_NOT_PRICE/);
  assert.throws(() => verifyExtractedPlan({ ...local, frequency: 'monthly' }, 'i havent save anything yet', local), /UNSUPPORTED_CONTRIBUTION_FREQUENCY/);
  const extra = { ...local, operation: 'goal_change' as const, delta: 3000, frequency: 'monthly' as const };
  assert.throws(() => verifyExtractedPlan({ ...extra, contribution: 3000 }, 'If I earn an extra ₱3,000 monthly, when will I reach my goal?', extra), /CONFLICTING_AMOUNT_ROLE/);
  assert.throws(() => verifyExtractedPlan({ ...local, goalNames: ['Emergency'] }, 'how long until I can buy the phone?', local), /UNSUPPORTED_GOAL_SELECTION/);
});

test('stale generated savings falls back to the latest user correction', async () => {
  const previous = context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 1000, contribution: 1000, frequency: 'monthly' });
  const answer = await answerFinancialPlan('i havent save anything yet', completeFacts(), 'owner-a', [
    { question: 'current savings: 1000', answer: 'How much can you contribute?', pendingAction: previous },
  ], { reserve: async () => {}, generate: async () => ({ text: JSON.stringify(previous.plan) }) as GenerateContentResponse });
  assert.equal(answer?.context.plan.saved, 0);
  assert.equal(answer?.result.values.periods, 195);
  assert.equal(answer?.model, 'local-financial-planner-v1');
});

test('the matching recorded goal provides saved balance and monthly allocation and refreshes next turn', async () => {
  const facts = completeFacts();
  facts.goals.push({ name: 'iPhone 18 Pro Max', target: 194990, saved: 1000, monthlyAllocation: 1000 });
  const answer = await answerFinancialPlan('how long will it take for me to buy the latest iphone 18 pro max?', facts, 'owner-a', [], offline);
  assert.ok(answer);
  assert.deepEqual(answer.result.missing, []);
  assert.equal(answer.result.values.periods, 194);
  assert.equal(answer.result.values.saved, 1000);
  assert.equal(answer.result.values.contribution, 1000);
  assert.match(answer.content, /Using your recorded "iPhone 18 Pro Max" goal/);
  assert.match(answer.content, /Recorded monthly allocation: ₱1,000\.00/);
  assert.equal(answer.context.plan.saved, undefined, 'Stored goal values must be reloaded, not persisted as hypothetical overrides');
  facts.goals.at(-1)!.saved = 4000;
  facts.goals.at(-1)!.monthlyAllocation = 2000;
  const refreshed = await answerFinancialPlan('And at the current pace?', facts, 'owner-a', [
    { question: 'How long?', answer: answer.content, pendingAction: answer.context },
  ], offline);
  assert.equal(refreshed?.result.values.saved, 4000);
  assert.equal(refreshed?.result.values.contribution, 2000);
  assert.equal(refreshed?.result.values.periods, 96);
});

test('recorded Safe-to-Spend does not silently become recurring income or dedicated goal savings', () => {
  const facts = completeFacts();
  facts.breakdown = { ...facts.breakdown, actualIncome: 12000, totalIncome: 12000, totalExpenses: 7000, totalFixed: 2000, totalLoanRepayments: 1000, totalSavings: 1500, rawSafeToSpend: 500, safeToSpend: 500 };
  const result = executeFinancialPlan({ operation: 'goal_timeline', target: 194990, saved: 0 }, facts);
  assert.equal(result.values.receivedIncome, 12000);
  assert.equal(result.values.recordedSpending, 7000);
  assert.equal(result.values.reservedBills, 2000);
  assert.equal(result.values.reservedDebt, 1000);
  assert.equal(result.values.reservedSavings, 1500);
  assert.equal(result.values.periodSafeToSpend, 500);
  assert.equal(result.values.contribution, undefined);
  assert.deepEqual(result.missing, ['contribution']);
  assert.match(result.content, /not a confirmed recurring saving amount/);
  assert.doesNotMatch(result.content, /30,000\.00 received/);
});

test('amount without contribution frequency gives a count without inventing months', () => {
  const result = executeFinancialPlan({ operation: 'goal_timeline', target: 194990, saved: 0, contribution: 1000 }, completeFacts());
  assert.equal(result.values.periods, 195);
  assert.match(result.content, /195 contribution\(s\)/);
  assert.doesNotMatch(result.content, /195 monthly|16 year/);
});

test('extra monthly money increases the existing goal contribution instead of replacing it', () => {
  const plan = localFinancialPlan('If I earn an extra ₱3,000 monthly, when will I reach my Laptop goal?', completeFacts())!;
  assert.equal(plan.operation, 'goal_change');
  assert.equal(plan.delta, 3000);
  assert.equal(plan.contribution, undefined);
  assert.equal(executeFinancialPlan(plan, completeFacts()).values.contribution, 7000);
  assert.equal(executeFinancialPlan(plan, completeFacts()).values.periods, 6);
});

test('personal record questions reach the matching income, spending, goal and account summaries', () => {
  const facts = completeFacts();
  for (const [question, expected] of [
    ['What is my income?', /30,000\.00 of received income/],
    ['How much have I spent?', /5,100\.00 in expenses/],
    ['Show my savings goals', /Laptop: ₱10,000\.00 of ₱50,000\.00/],
    ['Show my wallet balances', /Cash: ₱20,000\.00/],
    ['What are my unpaid bills?', /Rent: ₱2,000\.00 remaining/],
    ['Show my debts', /12,000\.00 still owed by you/],
  ] as const) {
    assert.equal(localFinancialPlan(question, facts), null, question);
    assert.match(coreReply(question, facts).content, expected, question);
  }
});

test('checking personal records mid-plan preserves the scenario, while cancellation stops it', async () => {
  const previous = context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 0 });
  const history = [
    { question: 'How long until I can buy the phone?', answer: 'How much can you save?', pendingAction: previous },
    { question: 'What is my income?', answer: 'Fresh received income from the user records', pendingAction: null },
  ];
  const answer = await answerFinancialPlan('1000 monthly', completeFacts(), 'owner-a', history, offline);
  assert.equal(answer?.context.plan.target, 194990);
  assert.equal(answer?.result.values.periods, 195);
  history.push({ question: 'start over', answer: 'Cancelled.', pendingAction: null });
  const restarted = await answerFinancialPlan('How long until I can buy the phone?', completeFacts(), 'owner-a', history, offline);
  assert.equal(restarted?.context.plan.target, undefined);
});

test('existing screenshot chats recover allocation and zero savings omitted by the old parser', async () => {
  const oldState = context({ operation: 'goal_timeline', language: 'en', target: 194990 });
  const history = [
    { question: '₱194,990.00, iphone 18 pro max, allocated savings: 1000', answer: 'How much is already saved?', pendingAction: oldState },
    { question: 'i havent save anything yet', answer: 'How much is already saved?', pendingAction: oldState },
  ];
  const answer = await answerFinancialPlan('monthly', completeFacts(), 'owner-a', history, offline);
  assert.deepEqual(answer?.result.missing, []);
  assert.equal(answer?.context.plan.target, 194990);
  assert.equal(answer?.context.plan.saved, 0);
  assert.equal(answer?.context.plan.contribution, 1000);
  assert.equal(answer?.result.values.periods, 195);
  const updatedState = context({ ...answer!.context.plan, contribution: 2000 });
  history.push({ question: '2000', answer: 'Updated contribution', pendingAction: updatedState });
  const updated = await answerFinancialPlan('And at the current pace?', completeFacts(), 'owner-a', history, offline);
  assert.equal(updated?.result.values.contribution, 2000, 'A newer validated bare-number reply wins over the old allocation label');
  assert.equal(updated?.result.values.periods, 98);
});

test('clarification neither accepts another owner scenario nor turns a model number into a price', async () => {
  const otherOwner = context({ operation: 'goal_timeline', language: 'en', target: 194990, saved: 20000, contribution: 5000 });
  otherOwner.owner = 'owner-b';
  const answer = await answerFinancialPlan('How long until I can buy an iPhone 18 Pro Max?', completeFacts(), 'owner-a', [
    { question: 'Private scenario', answer: 'Private answer', pendingAction: otherOwner },
  ], offline);
  assert.ok(answer?.result.missing.includes('target_price'));
  assert.equal(answer?.context.plan.target, undefined);
  assert.equal(answer?.context.plan.saved, undefined);
});
