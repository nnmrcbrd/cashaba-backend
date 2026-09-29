import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialReview, type FinancialReviewInput } from './financialReview';

const healthyInput: FinancialReviewInput = {
  totalIncome: 30_000,
  configuredIncome: 30_000,
  totalExpenses: 12_000,
  netCashFlow: 18_000,
  projectedBalance: 14_000,
  budgetConfigured: true,
  budgetTarget: 20_000,
  budgetSpent: 12_000,
  savingsTarget: 50_000,
  savingsSaved: 20_000,
  expenseChangePct: -10,
  topCategory: { name: 'Food & Dining', amount: 5_000, percentage: 42 },
};

test('summarizes an on-track financial period', () => {
  const review = buildFinancialReview(healthyInput);
  assert.equal(review.status.label, 'On track');
  assert.match(review.strongestArea, /Positive cash flow/);
  assert.match(review.mainConcern, /Food & Dining/);
});

test('prioritizes a projected shortfall', () => {
  const review = buildFinancialReview({ ...healthyInput, projectedBalance: -2_500 });
  assert.equal(review.status.label, 'Needs attention');
  assert.match(review.mainConcern, /projected shortfall/i);
  assert.match(review.recommendedAction, /Reduce flexible spending/);
});

test('reports when the configured budget is exceeded', () => {
  const review = buildFinancialReview({ ...healthyInput, budgetSpent: 22_000, projectedBalance: 8_000 });
  assert.equal(review.status.label, 'Over budget');
  assert.match(review.mainConcern, /exceeded/);
});

test('handles an account without financial history', () => {
  const review = buildFinancialReview({
    ...healthyInput,
    totalIncome: 0,
    configuredIncome: 0,
    totalExpenses: 0,
    netCashFlow: 0,
    projectedBalance: 0,
    budgetConfigured: false,
    budgetTarget: 0,
    budgetSpent: 0,
    savingsTarget: 0,
    savingsSaved: 0,
    expenseChangePct: null,
    topCategory: null,
  });
  assert.equal(review.status.label, 'Getting started');
});
