import test from 'node:test';
import assert from 'node:assert/strict';
import { coreReply, coreTopic, groundReply, renderGroundedReply, readCoreContext, isCoreQuestion } from './coreConversation';
import type { AdviceFacts } from './personalFinanceAdvice';

const facts: AdviceFacts = {
  breakdown: { configuredIncome: 10000, actualIncome: 2500, totalIncome: 2500, totalFixed: 0, totalSavings: 0, totalExpenses: 2648, totalLoanRepayments: 0, rawSafeToSpend: -148, safeToSpend: 0, periodStart: '2026-10-01', periodEnd: '2026-11-01' },
  incomePeriod: 'monthly', goals: [], accounts: [{ name: 'My Cash', balance: 500, kind: 'ASSET' }], bills: [], loans: [], budget: { target: 5000, spent: 2648 },
};

test('Cebuano Safe-to-Spend questions and follow-ups retain the financial topic', () => {
  for (const question of ['nganong 0 ang safe to spend?', 'unsa ang safe to spend?', 'unsay Safe-to-Spend?', 'pila akong safe to spend?']) {
    assert.equal(isCoreQuestion(question), true, question);
    const turn = coreReply(question, facts);
    assert.equal(turn.context.topic, 'safe-to-spend', question);
    assert.match(turn.content, /₱0\.00/);
    assert.doesNotMatch(turn.content, /I can help with/);
  }
  const previous = coreReply('Why is my Safe-to-Spend zero?', facts).context;
  for (const question of ['nganong 0 siya nga naa naman gi butang sa on boarding?', 'nganong 0 siya nga naa naman gi butang sa onboarding?', 'wala ko kasabot', 'unsaon mana?']) {
    const turn = coreReply(question, facts, previous);
    assert.equal(isCoreQuestion(question), true, question);
    assert.equal(turn.context.topic, 'safe-to-spend', question);
    assert.match(turn.content, /₱0\.00/);
    assert.doesNotMatch(turn.content, /I can help with/);
  }
  assert.equal(coreTopic('unsa akong wallet balance?', previous), 'accounts');
  assert.equal(coreTopic('unsay monthly budget?', previous), 'budget');
  assert.equal(coreTopic('How do I transfer money without changing Safe-to-Spend?', previous), 'transfers');
  assert.equal(isCoreQuestion('Pay 500 from Cash today'), false);
});
test('core feature questions explain existing navigation and preserve the topic for informal follow-ups', () => {
  const cases = [
    ['How do I set up a savings goal?', 'savings', 'Planning → Budget & Goals'],
    ['How can I record income?', 'income', 'Transaction History'],
    ['How do I transfer between my wallets?', 'transfers', 'source, destination'],
    ['Why is the graph different?', 'analytics', 'selected period'],
    ['How do I import CSV?', 'transactions', 'previews a statement'],
    ['What is a monthly budget?', 'budget', '₱5,000.00'],
    ['What are my account balances?', 'accounts', 'My Cash'],
    ['Why do I need email verification?', 'registration', 'emailed verification code'],
  ];
  for (const [question, topic, expected] of cases) {
    const turn = coreReply(question!, facts);
    assert.equal(turn.context.topic, topic);
    assert.ok(turn.content.includes(expected!), question);
    assert.equal(coreTopic('what? i dont get it', turn.context), topic);
  }
  const budget = coreReply('How is my budget?', facts);
  const simple = coreReply('explain that simply', facts, budget.context);
  assert.match(simple.content, /spending limit, not extra cash/);
  assert.doesNotMatch(simple.content, /I can help/);
});
test('grounded conversation accepts only server-rendered numbers and known entity references', () => {
  const grounded = groundReply('Your Safe-to-Spend is ₱0.00. The goal CASHA_ENTITY_1 has ₱500.25 saved (5%).');
  assert.equal(renderGroundedReply(grounded.template, grounded.values), 'Your Safe-to-Spend is ₱0.00. The goal CASHA_ENTITY_1 has ₱500.25 saved (5%).');
  for (const invalid of ['You have ₱90000 available.', 'Saved [[missing]].', 'Savings are [[fact_0', 'You can save ten thousand pesos.', 'I have recorded your payment.', 'Guaranteed returns are available.', 'Use CASHA_ENTITY_99.']) assert.equal(renderGroundedReply(invalid, grounded.values), null, invalid);
  assert.equal(renderGroundedReply('Review commitments before choosing a monthly amount.', grounded.values), 'Review commitments before choosing a monthly amount.');
  assert.equal(renderGroundedReply('Your goal has PHP 500.25 saved.', grounded.values), 'Your goal has ₱500.25 saved.');
  assert.equal(renderGroundedReply('Your Safe-to-Spend is ₱0.', grounded.values), 'Your Safe-to-Spend is ₱0.00.');
  assert.equal(renderGroundedReply('Your goal has ₱5000.25 saved.', grounded.values), null);
});
test('core context survives a pause while unrelated requests can start a new topic', () => {
  const budget = coreReply('Explain my budget', facts);
  assert.equal(readCoreContext(budget.context)?.topic, 'budget');
  assert.equal(readCoreContext(budget.context, Date.now() + 24 * 60 * 60_000), null);
  assert.equal(readCoreContext(budget.context, Date.now() - 2 * 60_000), null);
  assert.equal(coreTopic('Would that be a good idea?', budget.context), 'budget');
  assert.equal(coreTopic('Tell me the weather', budget.context), 'help');
  assert.equal(coreTopic('thanks', budget.context), 'help');
  assert.equal(coreReply('What is the weather?', facts, budget.context).context.topic, 'help');
  assert.match(coreReply('Write a poem', facts).content, /I focus on Casha-Ba/);
});

test('retry and frustration continue the actual usage question across saved context', () => {
  let context = coreReply('how to use casha-ba?', facts).context;
  for (const message of ['im asking', 'stupid', 'answer my question', 'you did not answer my question']) {
    const reloaded = readCoreContext(JSON.parse(JSON.stringify(context)));
    const reply = coreReply(message, facts, reloaded);
    assert.equal(isCoreQuestion(message), true, message);
    assert.match(reply.content, /Money → Wallet & Accounts/, message);
    assert.match(reply.content, /Money → Transaction History/, message);
    assert.doesNotMatch(reply.content, /What would you like to understand|I am here to help|I apologize/, message);
    assert.equal((reply.context as { originalQuestion?: string }).originalQuestion, 'how to use casha-ba?');
    context = reply.context;
  }
});

test('retry uses fresh records and an explicit new question replaces the previous one', () => {
  const budget = coreReply('How is my budget?', facts);
  const changed = { ...facts, budget: { target: 5000, spent: 3500 } };
  assert.match(coreReply('that is not what I asked', changed, budget.context).content, /₱3,500\.00/);
  const wallet = coreReply('What are my account balances?', facts, budget.context);
  const retry = coreReply('im asking', facts, wallet.context);
  assert.match(retry.content, /My Cash/);
  assert.doesNotMatch(retry.content, /₱5,000\.00|What would you like/);
  const usage = coreReply('How do I use Casha-Ba?', facts);
  const budgetWhy = coreReply('Why is my budget exceeded?', facts, usage.context);
  assert.equal(budgetWhy.context.originalQuestion, 'Why is my budget exceeded?');
  const budgetRetry = coreReply('im asking', changed, budgetWhy.context);
  assert.match(budgetRetry.content, /₱3,500\.00/);
  assert.doesNotMatch(budgetRetry.content, /To use Casha-Ba/);
  const reset = coreReply('What is the weather?', facts, wallet.context);
  assert.doesNotMatch(coreReply('im asking', facts, reset.context).content, /My Cash/);
});
