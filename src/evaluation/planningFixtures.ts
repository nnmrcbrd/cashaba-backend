import type { AdviceFacts } from '@/utils/personalFinanceAdvice';

// Synthetic, fixed-date data only. Never seeded into a user's database.
export function completeFacts(): AdviceFacts {
  return {
    incomePeriod: 'monthly',
    breakdown: { configuredIncome: 30000, actualIncome: 30000, totalIncome: 30000, totalFixed: 2000, totalSavings: 4000,
      totalExpenses: 5100, totalLoanRepayments: 500, rawSafeToSpend: 18400, safeToSpend: 18400,
      periodStart: '2026-09-30T16:00:00.000Z', periodEnd: '2026-10-31T16:00:00.000Z' },
    goals: [
      { name: 'Laptop', target: 50000, saved: 10000, monthlyAllocation: 4000 },
      { name: 'Emergency', target: 80000, saved: 20000, monthlyAllocation: 4000 },
      { name: 'Phone', target: 30000, saved: 5000, monthlyAllocation: 2500 },
      { name: 'Motorcycle', target: 80000, saved: 20000, monthlyAllocation: 4000 },
    ],
    budget: { target: 10000, spent: 5100 },
    accounts: [
      { name: 'Cash', kind: 'ASSET', accountType: 'CASH', balance: 20000 },
      { name: 'Bank', kind: 'ASSET', accountType: 'BANK', balance: 30000 },
      { name: 'Investment', kind: 'ASSET', accountType: 'INVESTMENT', balance: 100000 },
      { name: 'Credit', kind: 'LIABILITY', accountType: 'CREDIT_CARD', balance: 10000 },
    ],
    loans: [{ name: 'Loan', type: 'BORROWED', remaining: 12000 }, { name: 'Friend', type: 'LENT', remaining: 3000 }],
    bills: [{ name: 'Rent', remaining: 2000 }],
    planning: {
      asOf: '2026-10-08T04:00:00.000Z', currency: 'PHP', timezone: 'Asia/Manila',
      historyStart: '2025-10-01', historyEnd: '2026-10-08', firstRecord: '2026-08-01', recordCount: 14,
      nextPayday: '2026-10-15', lastPayday: '2026-10-01', essentialDaily: 100, protectedCash: 10000, recordsComplete: false,
      obligations: [{ name: 'Rent', amount: 3000, paid: 1000, due: '2026-10-10', anchor: '2026-10-10', frequency: 'MONTHLY' }],
      debts: [{ name: 'Loan', type: 'BORROWED', remaining: 12000, payment: 500, paid: 0, due: '2026-10-12', anchor: '2026-10-12', frequency: 'MONTHLY' }],
      spending: [
        { date: '2026-08-01', category: 'Salary', type: 'INCOME', amount: 25000 },
        { date: '2026-08-02', category: 'Food & Dining', type: 'EXPENSE', amount: 1000 },
        { date: '2026-09-01', category: 'Salary', type: 'INCOME', amount: 30000 },
        { date: '2026-09-02', category: 'Food & Dining', type: 'EXPENSE', amount: 1500 },
        { date: '2026-09-08', category: 'Transport', type: 'EXPENSE', amount: 800 },
        { date: '2026-09-20', category: 'Shopping', type: 'EXPENSE', amount: 2000 },
        { date: '2026-10-01', category: 'Salary', type: 'INCOME', amount: 30000 },
        { date: '2026-10-02', category: 'Food & Dining', type: 'EXPENSE', amount: 2000 },
        { date: '2026-10-03', category: 'Transport', type: 'EXPENSE', amount: 1000 },
        { date: '2026-10-04', category: 'Food Delivery', type: 'EXPENSE', amount: 600 },
        { date: '2026-10-06', category: 'Bills', type: 'BILL_PAYMENT', amount: 1000 },
        { date: '2026-10-07', category: 'Debt Payment', type: 'DEBT_PAYMENT', amount: 500 },
        { date: '2026-10-07', category: 'Savings', type: 'SAVINGS_CONTRIBUTION', amount: 800 },
        { date: '2026-10-08', category: 'Savings', type: 'SAVINGS_WITHDRAWAL', amount: 100 },
      ],
    },
  };
}
export function missingFacts(): AdviceFacts {
  const facts = completeFacts();
  facts.accounts = []; facts.goals = []; facts.loans = []; facts.bills = []; facts.budget = null;
  facts.breakdown = { ...facts.breakdown, configuredIncome: 0, actualIncome: 0, totalIncome: 0, totalFixed: 0, totalSavings: 0, totalExpenses: 0, totalLoanRepayments: 0, rawSafeToSpend: 0, safeToSpend: 0 };
  facts.planning = { ...facts.planning!, spending: [], obligations: [], debts: [], recordCount: 0, firstRecord: null, nextPayday: null, lastPayday: null, essentialDaily: null, protectedCash: null };
  return facts;
}
