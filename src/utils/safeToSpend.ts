import { prisma } from "@/lib/prisma";

/**
 * Safe-to-Spend = Total Income − SUM(Fixed Expenses) − SUM(Savings Allocations) − SUM(Expenses this period)
 * 
 * "This period" = current week if income_period is "weekly", current month if "monthly".
 * Result clamped to ₱0.00 minimum. Updates IncomeSetup.safeToSpend after calculation.
 */
export async function recalculateSafeToSpend(userId: string): Promise<number> {
  // 1. Get income setup
  const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
  if (!setup) return 0;

  // 2. Determine period date range
  const now = new Date();
  let periodStart: Date;

  if (setup.incomePeriod === "weekly") {
    // Start of current week (Monday)
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  } else {
    // Start of current month
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
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
      date: { gte: periodStart },
    },
    _sum: { amount: true },
  });
  const totalExpenses = expensesThisPeriod._sum.amount || 0;

  // 6. Calculate and clamp
  const safeToSpend = Math.max(0, setup.totalIncome - totalFixed - totalSavings - totalExpenses);

  // 7. Persist updated value
  await prisma.incomeSetup.update({
    where: { userId },
    data: { safeToSpend },
  });

  return safeToSpend;
}

/**
 * Get current Safe-to-Spend without recalculating (read from DB).
 */
export async function getSafeToSpend(userId: string): Promise<number> {
  const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
  return setup?.safeToSpend ?? 0;
}
