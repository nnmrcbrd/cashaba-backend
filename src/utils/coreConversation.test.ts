import test from 'node:test';
import assert from 'node:assert/strict';
import { coreReply, coreTopic, groundReply, renderGroundedReply, readCoreContext } from './coreConversation';
import type { AdviceFacts } from './personalFinanceAdvice';

const facts: AdviceFacts = {
  breakdown: { configuredIncome: 10000, actualIncome: 2500, totalIncome: 2500, totalFixed: 0, totalSavings: 0, totalExpenses: 2648, totalLoanRepayments: 0, rawSafeToSpend: -148, safeToSpend: 0, periodStart: '2026-10-01', periodEnd: '2026-11-01' },
  incomePeriod: 'monthly', goals: [], accounts: [{ name: 'My Cash', balance: 500, kind: 'ASSET' }], bills: [], loans: [], budget: { target: 5000, spent: 2648 },
};
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
  assert.equal(readCoreContext(budget.context, Date.now() + 24 * 60 * 60_000)?.topic, 'budget');
  assert.equal(readCoreContext(budget.context, Date.now() - 2 * 60_000), null);
  assert.equal(coreTopic('Would that be a good idea?', budget.context), 'budget');
  assert.equal(coreTopic('Tell me the weather', budget.context), 'help');
  assert.equal(coreTopic('thanks', budget.context), 'help');
  assert.equal(coreReply('What is the weather?', facts, budget.context).context.topic, 'help');
  assert.match(coreReply('Write a poem', facts).content, /I focus on Casha-Ba/);
});
