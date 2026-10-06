import test from 'node:test';
import assert from 'node:assert/strict';
import { personalAdviceTurn, recoverAdviceContext, readAdviceContext, statedPlanningAmount, isExplicitFinancialAction, transactionExplanation, personalFinanceReply, personalQuestionTopic, type AdviceFacts } from './personalFinanceAdvice';

const facts: AdviceFacts = {
  breakdown: { configuredIncome: 2000, actualIncome: 500, totalIncome: 500, totalFixed: 100, totalSavings: 200, totalExpenses: 50, totalLoanRepayments: 0, rawSafeToSpend: 150, safeToSpend: 150, periodStart: '2026-10-04T16:00:00Z', periodEnd: '2026-10-11T16:00:00Z' },
  incomePeriod: 'weekly', goals: [{ name: 'Phone', target: 30000, saved: 5000, monthlyAllocation: 2000 }],
  budget: { target: 7000, spent: 8000 }, accounts: [], loans: [], bills: [],
};

test('personal questions do not become financial writes, while explicit commands retain confirmation', () => {
  assert.equal(personalQuestionTopic('how many months will it take for me to buy the latest phone?'), 'timeline');
  assert.equal(personalQuestionTopic('How much is my income?'), 'income');
  assert.equal(personalQuestionTopic('Why is my Safe-to-Spend zero?'), 'safe-to-spend');
  assert.equal(personalQuestionTopic('Can you save 500 to Phone from Cash today'), null);
  assert.equal(personalQuestionTopic('Save 500 to Phone from Cash today'), null);
  assert.equal(personalQuestionTopic('I received 500 from Cash today'), null);
});

test('goal timeline is calculated from the actual saved target, balance and allocation', () => {
  const reply = personalFinanceReply('timeline', 'How long until I can buy a phone?', facts);
  assert.match(reply, /13 months/);
  assert.match(reply, /30,000\.00/);
  assert.match(reply, /5,000\.00/);
  assert.match(reply, /1 year and 1 month/);
  assert.match(reply, /every planned contribution/);
});

test('no goal or price asks one relevant question without guessing a price or repeating unrelated totals', () => {
  const reply = personalFinanceReply('timeline', 'How long to buy the latest phone?', { ...facts, goals: [] });
  assert.match(reply, /need the phone\/item price/);
  assert.match(reply, /What is its price in pesos/);
  assert.doesNotMatch(reply, /2,000|500|transaction|194,990/);
});

test('model numbers and unrelated goals cannot be mistaken for a phone price or savings', () => {
  const reply = personalFinanceReply('timeline', 'How long to buy an iPhone 16?', { ...facts, goals: [{ name: 'Tuition', target: 10000, saved: 9000, monthlyAllocation: 1000 }] });
  assert.match(reply, /need the phone\/item price/);
  assert.doesNotMatch(reply, /1 month/);
});

test('explicit price can override the matched target but no allocation means no invented timeline', () => {
  assert.match(personalFinanceReply('timeline', 'How long to buy a phone worth PHP 25000?', facts), /10 months/);
  const reply = personalFinanceReply('timeline', 'How long to buy a phone worth PHP 25000?', { ...facts, goals: [] });
  assert.match(reply, /No monthly allocation/);
  assert.doesNotMatch(reply, /estimate is/);
});

test('completed targets need no more saving and current budget uses recorded monthly spending', () => {
  assert.match(personalFinanceReply('timeline', 'How long to buy a phone?', { ...facts, goals: [{ ...facts.goals[0]!, saved: 30000 }] }), /no additional saving/);
  assert.match(personalFinanceReply('budget', 'How is my budget?', facts), /over budget by ₱1,000\.00/);
  assert.match(personalFinanceReply('income', 'What is my planned income?', facts), /8,666\.67/);
});

test('price and savings replies continue the same plan instead of becoming transactions', () => {
  const noGoal = { ...facts, goals: [] };
  const question = personalAdviceTurn('how long will it take for me to buy latest iphone?', noGoal)!;
  assert.equal(question.context?.awaiting, 'price');
  const price = personalAdviceTurn('194,990', noGoal, question.context)!;
  assert.match(price.content, /194,990\.00/);
  assert.equal(price.context?.awaiting, 'allocation');
  assert.doesNotMatch(price.content, /describe the transaction|estimate is/);
  const plan = personalAdviceTurn('2,000 per month', noGoal, price.context)!;
  assert.match(plan.content, /98 months/);
  assert.equal(plan.requiresClarification, false);
  assert.equal(plan.context?.price, 194990);
  assert.equal(plan.requiresClarification, false);
  const changed = personalAdviceTurn('what if I can save 5000 per month?', noGoal, plan.context)!;
  assert.match(changed.content, /39 months/);
  assert.equal(changed.context?.price, 194990);
});

test('screenshot conversation simplifies the same plan and offers practical follow-ups', () => {
  const noGoal = { ...facts, goals: [], breakdown: { ...facts.breakdown, safeToSpend: 0 } };
  const question = personalAdviceTurn('how long will it take for me to buy latest iphone?', noGoal)!;
  const price = personalAdviceTurn('194,990', noGoal, question.context)!;
  const plan = personalAdviceTurn('1000', noGoal, price.context)!;
  assert.match(plan.content, /195 months \(16 years and 3 months\)/);
  assert.match(plan.content, /Safe-to-Spend is ₱0\.00/);
  for (const followUp of ['what? i dont get it', 'I don’t understand', 'Can you explain that?', 'simplify please', 'Explain that in simpler terms', 'hindi ko gets', 'what does that mean?']) {
    const simpler = personalAdviceTurn(followUp, noGoal, plan.context)!;
    assert.match(simpler.content, /^In simpler terms:/);
    assert.match(simpler.content, /195 months/);
    assert.equal(simpler.context?.price, 194990);
    assert.equal(simpler.context?.monthlyAllocation, 1000);
    assert.ok(simpler.content.length < 650);
    assert.doesNotMatch(simpler.content, /÷|rounded up/, 'A request to simplify should not repeat the formula');
    assert.doesNotMatch(simpler.content, /I can help you plan|From your records/);
  }
  const faster = personalAdviceTurn('Can it be faster?', noGoal, plan.context)!;
  assert.match(faster.content, /₱2,000\.00 per month.*98 months/);
  const steps = personalAdviceTurn('what should i do next?', noGoal, plan.context)!;
  assert.match(steps.content, /Budget & Goals/);
  assert.match(steps.content, /allocation is your plan/);
  const restored = recoverAdviceContext([
    { question: '1000', model: 'local-personal-finance-v2', state: 'COMPLETED', pendingAction: plan.context },
    { question: 'what? i dont get it', model: 'local-fallback', state: 'COMPLETED', pendingAction: null },
  ], noGoal);
  assert.equal(restored?.price, 194990, 'Existing broken generic follow-up history should recover the same plan');
});

test('transaction explanation answers informal wording and retains the savings question', () => {
  const noGoal = { ...facts, goals: [] };
  const plan = personalAdviceTurn('How long to buy a phone worth PHP 194990?', noGoal)!;
  const explanation = personalAdviceTurn('what do u mean by transaction?', noGoal, plan.context)!;
  assert.match(explanation.content, /^A transaction is a financial entry/);
  assert.match(explanation.content, /How much can you set aside/);
  assert.equal(explanation.context?.price, 194990);
  assert.equal(transactionExplanation('what is a transaction?')?.startsWith('A transaction'), true);
});

test('only matching goals supply saved money, with fresh records on every follow-up', () => {
  const question = personalAdviceTurn('How long to buy the latest iphone?', facts)!;
  assert.match(question.content, /13 months/);
  const refreshed = { ...facts, goals: [{ ...facts.goals[0]!, saved: 10000, monthlyAllocation: 5000 }] };
  const reply = personalAdviceTurn('why is it so long?', refreshed, question.context)!;
  assert.match(reply.content, /4 months/);
  assert.match(reply.content, /10,000\.00/);
});

test('weekly plans are converted to months and hypothetical saving remains read-only', () => {
  const question = personalAdviceTurn('How long to buy a laptop worth PHP 30000?', { ...facts, goals: [] })!;
  const plan = personalAdviceTurn('save 1000 per week', { ...facts, goals: [] }, question.context)!;
  assert.match(plan.content, /7 months/);
  assert.match(plan.content, /52 weeks ÷ 12 months/);
  assert.equal(isExplicitFinancialAction('save 1000 per week'), false);
  assert.equal(isExplicitFinancialAction('Save 500 to Phone from Cash today'), true);
  assert.equal(personalAdviceTurn('Save 500 to Phone from Cash today', facts, question.context), null);
  assert.equal(personalQuestionTopic('save 1000 per week'), 'timeline');
});

test('zero allocation cannot produce an infinite or invented estimate', () => {
  const price = personalAdviceTurn('How long to buy a phone worth PHP 30000?', { ...facts, goals: [] })!;
  const zero = personalAdviceTurn('0', facts, price.context)!;
  assert.equal(zero.requiresClarification, true);
  assert.match(zero.content, /No monthly allocation/);
  assert.doesNotMatch(zero.content, /Infinity|estimate is/);
});

test('a number after an estimate asks whether it changes the price or monthly saving', () => {
  const plan = personalAdviceTurn('How long to buy a phone?', facts)!;
  const unclear = personalAdviceTurn('4000', facts, plan.context)!;
  assert.equal(unclear.context?.awaiting, 'change');
  assert.match(unclear.content, /new purchase price or a monthly savings amount/);
  assert.match(personalAdviceTurn('4000', facts, unclear.context)!.content, /new purchase price/);
  assert.match(personalAdviceTurn('4000 per month', facts, unclear.context)!.content, /7 months/);
});

test('ambiguous goals ask for selection and a new purchase excludes their balances', () => {
  const multiple = { ...facts, goals: [facts.goals[0]!, { name: 'iPhone', target: 60000, saved: 50000, monthlyAllocation: 1000 }] };
  const question = personalAdviceTurn('How long to buy a smartphone?', multiple)!;
  assert.equal(question.context?.awaiting, 'goal');
  assert.match(personalAdviceTurn('iPhone', multiple, question.context)!.content, /10 months/);
  const fresh = personalAdviceTurn('new purchase', multiple, question.context)!;
  assert.equal(fresh.context?.awaiting, 'price');
  assert.equal(fresh.context?.ignoreExistingGoals, true);
});

test('saved read-only conversation context survives reload and a pause, but stops on a new action', () => {
  const noGoal = { ...facts, goals: [] };
  const question = personalAdviceTurn('How long to buy a phone?', noGoal)!;
  const history = [{ question: 'How long to buy a phone?', model: 'local-personal-finance-v2', state: 'NEEDS_CLARIFICATION', pendingAction: question.context }];
  const recovered = recoverAdviceContext(history, noGoal);
  assert.equal(personalAdviceTurn('194,990', noGoal, recovered)?.context?.price, 194990);
  assert.equal(readAdviceContext(question.context, Date.now() + 24 * 60 * 60_000)?.awaiting, 'price');
  assert.equal(readAdviceContext(question.context, Date.now() - 2 * 60_000), null);
  assert.equal(recoverAdviceContext([...history, { question: 'Spent 100 on food from Cash today', model: 'local', state: 'AWAITING_CONFIRMATION', pendingAction: { intent: 'LOG_TRANSACTION' } }], noGoal), null);
  assert.equal(readAdviceContext({ ...question.context, price: -1 }), null);
});

test('legacy saved phone questions support the first bare-price follow-up', () => {
  const noGoal = { ...facts, goals: [] };
  const recovered = recoverAdviceContext([{ question: 'how long will it take for me to buy latest iphone?', model: 'local-personal-finance-v1', state: 'COMPLETED', pendingAction: null }], noGoal);
  assert.equal(personalAdviceTurn('194,990', noGoal, recovered)?.context?.price, 194990);
});

test('planning amounts reject model numbers, dates, negatives and malformed comma groups', () => {
  assert.equal(statedPlanningAmount('₱194,990.50'), 194990.5);
  for (const invalid of ['iPhone 16', '2026-10-06', '-2000', '19,49,90', 'Infinity', '2.0001']) assert.equal(statedPlanningAmount(invalid), null);
});
