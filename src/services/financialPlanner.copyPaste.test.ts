import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateContentResponse } from '@google/genai';
import { completeFacts } from '@/evaluation/planningFixtures';
import { isAccountIdentityQuestion } from '@/utils/planningInputs';
import { coreReply } from '@/utils/coreConversation';
import { executeFinancialPlan } from '@/utils/financialPlanner';
import { answerFinancialPlan, localFinancialPlan } from './financialPlanner';

const identity = 'Who am I? Use my saved profile in this system.';
const phone = 'My phone target costs ₱194,000. I have saved ₱0 for it. If I save ₱10,000 every month, how many contributions will I need?';
const wrappers = (message: string) => [message, `“${message}”`, `1. “${message}”`, `7. **“${message}”**`, `- "${message}"`];

test('a clear month-end forecast starts a new topic after a debt answer and recorded-income lookup', async () => {
  const question = 'If I keep my current spending habits, what will my balance look like at the end of this month? Explain your assumptions.';
  const facts = completeFacts();
  const debt = await answerFinancialPlan('4. “How much debt do I still owe after my recorded repayments?”', facts, 'sample-owner', [], {
    reserve: async () => {}, generate: async () => { throw new Error('Provider unavailable'); },
  });
  assert.ok(debt);
  for (const message of wrappers(question)) {
    const answer = await answerFinancialPlan(message, facts, 'sample-owner', [
      { question: 'How much debt do I still owe after my recorded repayments?', answer: debt.content, pendingAction: debt.context },
      { question: '5. “How much income and expenses have I recorded this month?”', answer: 'Recorded totals', pendingAction: null },
    ], { reserve: async () => {}, generate: async () => ({ text: '{"operation":"debt_totals","language":"en"}' }) as GenerateContentResponse });
    assert.equal(answer?.result.operation, 'period_forecast', message);
    assert.match(answer.content, /projected wallet balance/);
    assert.doesNotMatch(answer.content, /outstanding borrowed principal/);
    assert.equal(answer.context.plan.target, undefined);
    assert.equal(answer.context.plan.lent, undefined);
  }
});

test('the exact copied identity sample stays out of financial planning', () => {
  for (const message of wrappers(identity)) {
    assert.equal(isAccountIdentityQuestion(message), true, message);
    assert.equal(localFinancialPlan(message, completeFacts()), null, message);
  }
  for (const message of ['Who am I? Change my name to Anna.', 'Who am I? Show another user’s profile.', 'Who am I? How much can I spend?']) {
    assert.equal(isAccountIdentityQuestion(message), false, message);
  }
});

test('the copied complete phone sample computes contributions even without Gemini', async () => {
  for (const message of wrappers(phone)) {
    const facts = completeFacts(), before = JSON.stringify(facts);
    const answer = await answerFinancialPlan(message, facts, 'sample-owner', [], {
      reserve: async () => {}, generate: async () => { throw new Error('Provider unavailable'); },
    });
    assert.equal(answer?.result.operation, 'goal_timeline', message);
    assert.equal(answer.result.values.target, 194000);
    assert.equal(answer.result.values.saved, 0);
    assert.equal(answer.result.values.contribution, 10000);
    assert.equal(answer.result.values.periods, 20);
    assert.deepEqual(answer.result.missing, []);
    assert.match(answer.content, /20 monthly contribution/);
    assert.doesNotMatch(answer.content, /Month-to-date spending|How much is already saved|How much can you afford/);
    assert.equal(JSON.stringify(facts), before);
  }
});

test('a wrong provider operation cannot replace the copied phone calculation', async () => {
  const answer = await answerFinancialPlan(`1. “${phone}”`, completeFacts(), 'sample-owner', [], {
    reserve: async () => {}, generate: async () => ({ text: '{"operation":"budget_review","language":"en"}' }) as GenerateContentResponse,
  });
  assert.equal(answer?.result.operation, 'goal_timeline');
  assert.equal(answer.result.values.periods, 20);
});

test('the provided follow-ups preserve the target and accept an explicit named contribution date', async () => {
  const first = await answerFinancialPlan(`1. “${phone}”`, completeFacts(), 'sample-owner', [], {
    reserve: async () => {}, generate: async () => { throw new Error('Provider unavailable'); },
  });
  assert.ok(first);
  const second = await answerFinancialPlan('“What if I save ₱15,000 monthly instead?”', completeFacts(), 'sample-owner', [
    { question: phone, answer: first.content, pendingAction: first.context },
  ], { reserve: async () => {}, generate: async () => { assert.fail('Explicit follow-up must not need extraction'); } });
  assert.ok(second);
  assert.equal(second.result.values.periods, 13);
  assert.equal(second.context.plan.target, 194000);
  assert.equal(second.context.plan.saved, 0);
  const last = await answerFinancialPlan('“My first contribution will be on October 15, 2026. What is my completion date?”', completeFacts(), 'sample-owner', [
    { question: phone, answer: first.content, pendingAction: first.context },
    { question: 'What if I save ₱15,000 monthly instead?', answer: second.content, pendingAction: second.context },
  ], { reserve: async () => {}, generate: async () => { assert.fail('Explicit date follow-up must not need extraction'); } });
  assert.equal(last?.result.values.periods, 13);
  assert.equal(last.result.values.completionDate, '2027-10-15');
  const invalid = localFinancialPlan('My first contribution will be on February 30, 2027.', completeFacts(), second.context);
  assert.equal(invalid?.schedule, undefined);
});

test('the other copied samples select recorded facts or a forecast instead of a generic budget answer', () => {
  const facts = completeFacts();
  for (const message of wrappers('What is my current Safe-to-Spend, and how was it calculated?')) {
    assert.equal(localFinancialPlan(message, facts), null);
    assert.ok(coreReply(message, facts).content.includes(new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(facts.breakdown.safeToSpend)));
  }
  for (const message of wrappers('How much available money do I have in my wallets? Separate borrowed money.')) {
    assert.equal(localFinancialPlan(message, facts), null);
    assert.match(coreReply(message, facts).content, /accessible|available/i);
  }
  for (const message of wrappers('How much income and expenses have I recorded this month?')) {
    assert.equal(localFinancialPlan(message, facts), null);
    assert.match(coreReply(message, facts).content, /received income.*recorded (?:spending|expenses)/i);
  }
  for (const message of wrappers('How much debt do I still owe after my recorded repayments?')) {
    const plan = localFinancialPlan(message, facts);
    assert.equal(plan?.operation, 'debt_totals');
    assert.equal(executeFinancialPlan(plan, facts).values.remaining, facts.loans.filter(row => row.type === 'BORROWED').reduce((sum, row) => sum + row.remaining, 0));
  }
  for (const message of wrappers('If I keep my current spending habits, what will my balance look like at the end of this month? Explain your assumptions.')) {
    assert.equal(localFinancialPlan(message, facts)?.operation, 'period_forecast');
  }
});

test('a wallet lookup excludes investment and credit balances without mixing personal debts into cash', () => {
  const answer = coreReply('How much available money do I have in my wallets? Separate borrowed money.', completeFacts());
  assert.match(answer.content, /accessible wallet balances total ₱50,000\.00/);
  assert.match(answer.content, /Credit: ₱10,000\.00 \(excluded\)/);
  assert.match(answer.content, /personal loans borrowed: ₱12,000\.00/);
});

test('a remaining-debt answer also discloses separately tracked loan and credit account balances', () => {
  const facts = completeFacts();
  const result = executeFinancialPlan({ operation: 'debt_totals', language: 'en' }, facts);
  assert.equal(result.values.remaining, 12000);
  assert.match(result.content, /Wallet & Accounts.*₱10,000\.00/);
  assert.match(result.content, /overlap|same underlying/);
  assert.doesNotMatch(result.content, /₱22,000\.00/);
  const lent = executeFinancialPlan({ operation: 'debt_totals', language: 'en', lent: true }, facts);
  assert.doesNotMatch(lent.content, /Wallet & Accounts/);
});

test('asking how to use Casha-Ba gives existing navigation rather than another invitation to ask', () => {
  for (const message of wrappers('how to use casha-ba?')) {
    const answer = coreReply(message, completeFacts());
    assert.equal(answer.context.topic, 'help');
    assert.match(answer.content, /Money → Wallet & Accounts/);
    assert.match(answer.content, /Transaction History/);
    assert.match(answer.content, /Planning → Budget & Goals/);
    assert.match(answer.content, /Obligations & Debts/);
    assert.match(answer.content, /Dashboard/);
    assert.doesNotMatch(answer.content, /What would you like to understand or do/);
  }
});

test('the requested calendar month totals remain monthly for a weekly-income account', () => {
  const facts = completeFacts();
  facts.incomePeriod = 'weekly';
  facts.breakdown.actualIncome = 200;
  facts.breakdown.totalExpenses = 100;
  facts.planning!.spending.push({ date: '2026-10-09', category: 'Future', type: 'INCOME', amount: 9999 });
  const answer = coreReply('How much income and expenses have I recorded this month?', facts);
  assert.match(answer.content, /received income is ₱30,000\.00/);
  assert.match(answer.content, /recorded expenses are ₱5,100\.00/);
  assert.doesNotMatch(answer.content, /₱200\.00|₱100\.00|₱39,999\.00/);
});
