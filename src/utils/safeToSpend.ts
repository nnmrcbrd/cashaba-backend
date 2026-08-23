import { prisma } from "@/lib/prisma";

/**
 * Safe-to-Spend = Total Income − SUM(Fixed Expenses) − SUM(Savings Allocations) − SUM(Expenses this period)
 * 
 * "This period" = current week if income_period is "weekly", current month if "monthly".
 * Result clamped to ₱0.00 minimum. Updates IncomeSetup.safeToSpend after calculation.
 */
export interface SafeToSpendBreakdown {
  totalIncome: number;
  totalFixed: number;
  totalSavings: number;
  totalExpenses: number;
  totalLoanRepayments: number;
  rawSafeToSpend: number;
  safeToSpend: number;
}

export async function calculateSafeToSpend(userId: string): Promise<SafeToSpendBreakdown> {
  // 1. Get income setup
  const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
  if (!setup) {
    return {
      totalIncome: 0,
      totalFixed: 0,
      totalSavings: 0,
      totalExpenses: 0,
      totalLoanRepayments: 0,
      rawSafeToSpend: 0,
      safeToSpend: 0,
    };
  }

  // 2. Determine period date range
  const now = new Date();
  let periodStart: Date;
  let periodEnd: Date;

  if (setup.incomePeriod === "weekly") {
    // Start of current week (Monday)
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 7);
  } else {
    // Start of current month
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  periodStart.setHours(0, 0, 0, 0);

  // 3. Sum fixed expenses
  const fixedExpenses = await prisma.fixedExpense.findMany({ where: { userId } });
  const totalFixed = fixedExpenses.reduce((sum, fe) => sum + fe.amount, 0);

  // 4. Sum savings allocations (monthly allocations from active goals)
  const savingsGoals = await prisma.savingsGoal.findMany({
    where: { userId, isCompleted: false },
  });
  const totalSavings = savingsGoals.reduce((sum, sg) => sum + sg.monthlyAllocation, 0);

  // 5. Sum expenses logged this period
  const expensesThisPeriod = await prisma.transaction.aggregate({
    where: {
      userId,
      type: "EXPENSE",
      date: { gte: periodStart, lt: periodEnd },
    },
    _sum: { amount: true },
  });
  const totalExpenses = expensesThisPeriod._sum.amount || 0;

  // Reserve borrowed-loan repayments due during or before this period.
  const dueLoans = await prisma.loan.findMany({
    where: {
      userId,
      type: "BORROWED",
      status: { in: ["ACTIVE", "OVERDUE"] },
      repaymentAmount: { gt: 0 },
      deadline: { lt: periodEnd },
    },
    select: { amount: true, amountPaid: true, repaymentAmount: true },
  });
  const totalLoanRepayments = dueLoans.reduce(
    (sum, loan) => sum + Math.min(loan.repaymentAmount, Math.max(0, loan.amount - loan.amountPaid)),
    0,
  );

  // 6. Calculate and clamp
  const rawSafeToSpend = setup.totalIncome - totalFixed - totalSavings - totalLoanRepayments - totalExpenses;
  const safeToSpend = Math.max(0, rawSafeToSpend);

  return {
    totalIncome: setup.totalIncome,
    totalFixed,
    totalSavings,
    totalExpenses,
    totalLoanRepayments,
    rawSafeToSpend,
    safeToSpend,
  };
}

export async function recalculateSafeToSpend(userId: string): Promise<number> {
  const breakdown = await calculateSafeToSpend(userId);
  const setup = await prisma.incomeSetup.findUnique({ where: { userId }, select: { id: true } });
  if (!setup) return 0;

  // 7. Persist updated value
  await prisma.incomeSetup.update({
    where: { userId },
    data: { safeToSpend: breakdown.safeToSpend },
  });

  return breakdown.safeToSpend;
}

/**
 * Get current Safe-to-Spend without recalculating (read from DB).
 */
export async function getSafeToSpend(userId: string): Promise<number> {
  const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
  return setup?.safeToSpend ?? 0;
}
