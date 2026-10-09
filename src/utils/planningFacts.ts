export interface PlanningFacts {
  asOf: string;
  currency: 'PHP';
  timezone: 'Asia/Manila';
  historyStart: string;
  historyEnd: string;
  firstRecord: string | null;
  recordCount: number;
  // No schedule or completeness field exists in the current account schema.
  // Unknown fields are explicitly null, rather than guessed from incomePeriod.
  nextPayday: string | null;
  lastPayday: string | null;
  essentialDaily: number | null;
  protectedCash: number | null;
  recordsComplete: boolean;
  spending: Array<{ date: string; category: string; amount: number; type: string }>;
  obligations: Array<{ name: string; amount: number; paid: number; due: string | null; anchor: string | null; frequency: string }>;
  recurringObligations?: Array<{ name: string; amount: number; frequency: string }>;
  debts: Array<{ name: string; type: string; remaining: number; payment: number; paid: number; due: string; anchor: string | null; frequency: string }>;
}
