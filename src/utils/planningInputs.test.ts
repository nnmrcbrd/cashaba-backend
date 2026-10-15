import test from 'node:test';
import assert from 'node:assert/strict';
import { statedGoalInputs } from './planningInputs';
import { isExplicitFinancialAction } from './personalFinanceAdvice';

for (const message of [
  '1000, EVERY MONTH', '1,000, every month', '₱1,000.00, every month',
  '1000 pesos every month', '1000/month', '1000 monthly', 'every month, 1000',
  'Monthly contribution: 1000', 'I can save 1000, every month', 'I save 1000, every month',
]) {
  test(`a recurring contribution accepts ${JSON.stringify(message)}`, () => {
    const inputs = statedGoalInputs(message);
    assert.equal(inputs.contribution, 1000);
    assert.equal(inputs.frequency, 'monthly');
    assert.equal(inputs.target, undefined);
    assert.equal(inputs.saved, undefined);
    assert.equal(isExplicitFinancialAction(message), false);
  });
}

test('recurring amounts keep frequency, decimals, zero and extra savings roles', () => {
  for (const [message, contribution, frequency] of [
    ['250.50, each week', 250.50, 'weekly'], ['25 per day', 25, 'daily'],
    ['500, every payday', 500, 'payday'], ['0, every month', 0, 'monthly'],
  ] as const) {
    assert.deepEqual(statedGoalInputs(message), { contribution, frequency });
  }
  assert.deepEqual(statedGoalInputs('an extra 1000, every month'), { delta: 1000, frequency: 'monthly' });
  assert.deepEqual(statedGoalInputs('EVERY MONTH'), { frequency: 'monthly' });
});

test('invalid or ambiguous recurring input does not become a monetary contribution', () => {
  for (const message of [
    '-1000, every month', '₱-1000 monthly', '1,00, every month', '1000.001 monthly',
    'iPhone 18 Pro Max 2TB', 'for 12 months', 'for 1 month', '2026-10-08 monthly',
    '1000 or 2000 monthly', '1000 monthly or 2000 weekly', '1000 every 2 months',
  ]) assert.equal(statedGoalInputs(message).contribution, undefined, message);
});

test('explicit savings entries still require the financial action confirmation path', () => {
  for (const message of ['Save 1000 to Phone from Cash today', 'Record 1000 monthly from Cash today', 'I saved 1000 yesterday']) {
    assert.equal(isExplicitFinancialAction(message), true, message);
  }
});

test('a number of recurring contributions is a count rather than a peso amount', () => {
  for (const text of ['4 weekly contributions left', '12 monthly payments remaining', '6 daily deposits', '8 weekly periods']) {
    assert.equal(statedGoalInputs(text).contribution, undefined, text);
  }
  assert.equal(statedGoalInputs('4 weekly contributions left; I save ₱500 weekly').contribution, 500);
  assert.equal(statedGoalInputs('₱4 weekly contributions').contribution, 4);
  assert.equal(statedGoalInputs('weekly contribution: 4').contribution, 4);
});