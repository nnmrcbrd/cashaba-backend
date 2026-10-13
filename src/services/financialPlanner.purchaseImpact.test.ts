import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import { completeFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan, type FinancialPlan, type PlanningContext } from '@/utils/financialPlanner';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from './financialPlanner';

const question = 'How will buying a ₱10,000 tablet affect my other savings goals?';
const context = (plan: FinancialPlan): PlanningContext => ({ kind: 'FINANCIAL_PLAN_V1', owner: 'owner-a', updatedAt: new Date().toISOString(), plan });
const offline = { reserve: async () => {}, generate: async (): Promise<GenerateContentResponse> => { throw new Error('Provider unavailable'); } };

test('purchase effects retain the price for different products and ask only about unknown funding', () => {
  for (const item of ['tablet', 'phone', 'laptop', 'bicycle', 'appliance']) {
    for (const message of [`How will buying a ₱10,000 ${item} affect my other savings goals?`, `1. “How will buying a PHP 10000 ${item} affect my savings goals?”`]) {
      const facts = completeFacts(), before = JSON.stringify(facts);
      const plan = localFinancialPlan(message, facts)!;
      assert.equal(plan.purchase, 10000, message);
      assert.equal(plan.delta, undefined, 'Purchase price is not additional recurring saving');
      const result = executeFinancialPlan(plan, facts);
      assert.deepEqual(result.missing, ['purchase_funding'], message);
      assert.match(result.content, /₱10,000\.00/);
      assert.match(result.content, /available cash.*specific savings goal.*planned contributions/i);
      assert.doesNotMatch(result.content, /exact product variant|What is the target price|How much is already saved/);
      assert.equal(JSON.stringify(facts), before);
    }
  }
});

test('the funding answer survives saved context, uses fresh goal records and computes the actual delay', async () => {
  const facts = completeFacts();
  const first = await answerFinancialPlan(question, facts, 'owner-a', [], offline);
  assert.ok(first);
  let calls = 0;
  const history = [{ question, answer: first.content, pendingAction: JSON.parse(JSON.stringify(first.context)) }];
  const next = await answerFinancialPlan('From my Laptop savings goal', facts, 'owner-a', history,
    { reserve: async () => {}, generate: async () => { calls++; assert.fail('A clear funding answer needs no provider extraction'); } });
  assert.ok(next);
  assert.equal(calls, 0);
  assert.deepEqual(next.result.missing, []);
  assert.equal(next.result.values.purchase, 10000);
  assert.equal(next.result.values.baselinePeriods, 10);
  assert.equal(next.result.values.periods, 13);
  assert.equal(next.result.values.delayPeriods, 3);
  assert.equal(next.result.values.savedAfterPurchase, 0);
  assert.match(next.content, /Laptop.*₱10,000\.00/);
  assert.match(next.content, /other.*unchanged/i);
  facts.goals[0].saved = 20000;
  const refreshed = await answerFinancialPlan('im asking', facts, 'owner-a', [{ question: 'From my Laptop savings goal', answer: next.content, pendingAction: next.context }], offline);
  assert.equal(refreshed?.result.values.saved, 20000);
  assert.equal(refreshed?.result.values.savedAfterPurchase, 10000);
});

test('cash funding answers the effect without selecting a goal or asking again for the price', () => {
  const facts = completeFacts(), before = JSON.stringify(facts);
  const first = localFinancialPlan(question, facts)!;
  const cash = localFinancialPlan('I will use available cash and keep my contributions unchanged', facts, context(first))!;
  const result = executeFinancialPlan(cash, facts);
  assert.deepEqual(result.missing, []);
  assert.equal(result.values.walletBalanceAfterPurchase, 40000);
  assert.match(result.content, /goal balances.*unchanged/i);
  assert.doesNotMatch(result.content, /exact product variant|Which recorded goal|What is the target price/);
  assert.equal(JSON.stringify(facts), before);
});

test('a named goal does not automatically authorize funding; insufficient saved funds are clarified', () => {
  const facts = completeFacts();
  const unresolved = executeFinancialPlan(localFinancialPlan('How will buying a ₱10000 tablet affect my Laptop savings goal?', facts), facts);
  assert.deepEqual(unresolved.missing, ['purchase_funding']);
  const first = localFinancialPlan(question, facts)!;
  const selected = localFinancialPlan('From my Phone savings goal', facts, context(first))!;
  const result = executeFinancialPlan(selected, facts);
  assert.deepEqual(result.missing, ['funding_shortfall']);
  assert.equal(result.values.fundingShortfall, 5000);
  assert.match(result.content, /₱5,000\.00/);
  assert.equal(result.values.periods, undefined, 'Do not pretend the unfunded purchase was covered');
});

test('temporarily reduced contributions use the selected goal and confirmed number of periods', () => {
  const facts = completeFacts(), first = localFinancialPlan(question, facts)!;
  const choice = localFinancialPlan('Reduce planned contributions to my Laptop goal', facts, context(first))!;
  const missing = executeFinancialPlan(choice, facts);
  assert.deepEqual(missing.missing, ['contribution_plan']);
  assert.doesNotMatch(missing.content, /variant|target price/);
  const details = localFinancialPlan('contribution: 2000 monthly for 5 periods', facts, context(choice))!;
  const result = executeFinancialPlan(details, facts);
  assert.deepEqual(result.missing, []);
  assert.equal(result.values.redirectedContributions, 10000);
  assert.equal(result.values.baselinePeriods, 10);
  assert.equal(result.values.periods, 13);
  assert.equal(result.values.delayPeriods, 3);
});

test('provider extraction cannot invent funding or turn a known purchase cost into a goal target', () => {
  const plan = localFinancialPlan(question, completeFacts())!;
  for (const altered of [
    { ...plan, delta: 10000 }, { ...plan, target: 10000 }, { ...plan, withdrawal: 10000 },
    { ...plan, purchaseFunding: 'goal_savings' },
  ]) assert.throws(() => verifyExtractedPlan(altered, question, plan), /CONFLICTING_PURCHASE/);
});

test('different questions ask for their own missing inputs instead of a fixed funding or variant question', () => {
  const facts = completeFacts();
  const timeline = executeFinancialPlan(localFinancialPlan('How long to buy a ₱10000 tablet if I save ₱1000 monthly?', facts), facts);
  assert.deepEqual(timeline.missing, ['saved_balance']);
  const unknownPrice = executeFinancialPlan(localFinancialPlan('How long to buy a tablet if I save ₱1000 monthly?', facts), facts);
  assert.ok(unknownPrice.missing.includes('target_price'));
  assert.doesNotMatch(unknownPrice.content, /exact product variant/);
  const affordability = executeFinancialPlan(localFinancialPlan('Can I afford a ₱10000 tablet today?', facts), facts);
  assert.deepEqual(affordability.missing, []);
  assert.equal(affordability.values.affordable, true);
  assert.doesNotMatch(affordability.content, /specific savings goal|product variant/);
});

test('an unknown purchase cost is clarified without mistaking a contribution for its price', async () => {
  const facts = completeFacts();
  const unknown = localFinancialPlan('How will buying a tablet impact my savings goals if I save ₱1000 monthly?', facts)!;
  assert.equal(unknown.operation, 'goal_change');
  assert.equal(unknown.purchase, undefined);
  const result = executeFinancialPlan(unknown, facts);
  assert.deepEqual(result.missing, ['purchase_price']);
  assert.match(result.content, /What purchase cost in PHP/);
  assert.doesNotMatch(result.content, /variant|target price/);
  const reply = await answerFinancialPlan('10000', facts, 'owner-a', [{ question: 'How will buying a tablet impact my savings goals?',
    answer: result.content, pendingAction: context(unknown) }], { reserve: async () => {},
    generate: async () => { assert.fail('A direct price answer does not need extraction'); } });
  assert.equal(reply?.context.plan.purchase, 10000);
  assert.deepEqual(reply?.result.missing, ['purchase_funding']);
});

test('impact paraphrases preserve intent and an unrelated new question clears the purchase scenario', () => {
  const facts = completeFacts();
  for (const message of ['If I buy a ₱10000 bicycle, will it delay my goals?',
    'Would purchasing a PHP 10000 appliance impact my savings?']) {
    const plan = localFinancialPlan(message, facts)!;
    assert.equal(plan.operation, 'goal_change');
    assert.equal(plan.purchase, 10000);
    assert.deepEqual(executeFinancialPlan(plan, facts).missing, ['purchase_funding']);
  }
  const previous = context(localFinancialPlan(question, facts)!);
  const next = localFinancialPlan('How long to save ₱20000 with ₱1000 monthly and nothing saved?', facts, previous)!;
  assert.equal(next.operation, 'goal_timeline');
  assert.equal(next.purchase, undefined);
  assert.equal(next.purchaseFunding, undefined);
  assert.equal(next.goalChangeKind, undefined);
  assert.equal(executeFinancialPlan(next, facts).values.periods, 20);
});

test('a self-contained phone plan after a funded purchase clears the previous purchase context', async () => {
  const phone = 'My phone target costs ₱194,000. I have saved ₱0 for it. If I save ₱10,000 every month, how many contributions will I need?';
  for (const message of [phone, `1. “${phone}”`, `1. “${phone}” This is a hypothetical plan.`]) {
    const facts = completeFacts(), before = JSON.stringify(facts);
    const first = await answerFinancialPlan(question, facts, 'owner-a', [], offline);
    assert.ok(first);
    const funding = 'For this hypothetical purchase, I will use available cash and keep my savings contributions unchanged. Do not change any financial records.';
    const funded = await answerFinancialPlan(funding, facts, 'owner-a', [
      { question, answer: first.content, pendingAction: first.context },
    ], offline);
    assert.ok(funded);
    const next = await answerFinancialPlan(message, facts, 'owner-a', [
      { question, answer: first.content, pendingAction: JSON.parse(JSON.stringify(first.context)) },
      { question: funding, answer: funded.content, pendingAction: JSON.parse(JSON.stringify(funded.context)) },
    ], offline);
    assert.equal(next?.result.operation, 'goal_timeline', message);
    assert.equal(next.result.values.target, 194000);
    assert.equal(next.result.values.saved, 0);
    assert.equal(next.result.values.contribution, 10000);
    assert.equal(next.result.values.periods, 20);
    assert.equal(next.context.plan.purchase, undefined);
    assert.equal(next.context.plan.purchaseFunding, undefined);
    assert.equal(next.context.plan.goalChangeKind, undefined);
    assert.deepEqual(next.result.missing, []);
    assert.match(next.content, /20 monthly contribution/);
    assert.doesNotMatch(next.content, /Paying.*accessible wallet cash|Purchase cost:/);
    assert.equal(JSON.stringify(facts), before);
  }
});

test('provider extraction cannot reintroduce purchase funding into a fresh savings timeline', () => {
  const message = 'My phone target costs ₱194000. I have saved ₱0. I save ₱10000 monthly. How many contributions will I need?';
  const local = localFinancialPlan(message, completeFacts())!;
  for (const stale of [{ purchase: 10000 }, { purchaseFunding: 'cash' }, { goalChangeKind: 'purchase' }]) {
    assert.throws(() => verifyExtractedPlan({ ...local, ...stale }, message, local), /CONFLICTING_PURCHASE_INPUT/);
  }
});

test('reloaded history does not restore purchase fields from an earlier wrong answer to the same phone question', async () => {
  const facts = completeFacts();
  const phone = 'My phone target costs ₱194000. I have saved ₱0. I save ₱10000 monthly. How many contributions will I need?';
  const legacy = context({ operation: 'goal_change', language: 'en', goalChangeKind: 'purchase', purchase: 10000,
    purchaseFunding: 'cash', target: 194000, saved: 0, contribution: 10000, frequency: 'monthly' });
  const corrected = await answerFinancialPlan(phone, facts, 'owner-a', [{ question: phone,
    answer: 'Previous purchase answer', pendingAction: JSON.parse(JSON.stringify(legacy)) }], offline);
  assert.ok(corrected);
  const follow = await answerFinancialPlan('My first contribution will be on October 15, 2026. What is my completion date?',
    facts, 'owner-a', [
      { question: phone, answer: 'Previous purchase answer', pendingAction: JSON.parse(JSON.stringify(legacy)) },
      { question: phone, answer: corrected.content, pendingAction: JSON.parse(JSON.stringify(corrected.context)) },
    ], offline);
  assert.equal(follow?.result.operation, 'goal_timeline');
  assert.equal(follow.result.values.periods, 20);
  assert.equal(follow.result.values.completionDate, '2028-05-15');
  assert.equal(follow.context.plan.purchase, undefined);
  assert.equal(follow.context.plan.purchaseFunding, undefined);
  assert.equal(follow.context.plan.goalChangeKind, undefined);
});
