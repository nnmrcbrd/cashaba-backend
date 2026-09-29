import { prisma } from "../lib/prisma.js";

const duplicateBudgets = await prisma.$queryRaw<Array<{ count: number }>>`
  SELECT COUNT(*)::int AS count
  FROM (
    SELECT "userId", month, year
    FROM "Budget"
    GROUP BY "userId", month, year
    HAVING COUNT(*) > 1
  ) duplicates
`;

const [transactionsWithoutWallet, invalidTransfers, negativeSavingsGoals, overpaidLoans, overpaidObligations, invalidOnboardingSteps] = await Promise.all([
  prisma.transaction.count({ where: { deletedAt: null, walletId: null } }),
  prisma.transaction.count({ where: { deletedAt: null, type: "TRANSFER", OR: [{ destinationWalletId: null }, { walletId: null }] } }),
  prisma.savingsGoal.count({ where: { currentAmount: { lt: 0 } } }),
  prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM "Loan" WHERE "amount_paid" > "amount" OR "installment_paid" < 0`,
  prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM "FixedExpense" WHERE "amount_paid" < 0 OR "amount_paid" > "amount"`,
  prisma.user.count({ where: { OR: [{ onboardingStep: { lt: 1 } }, { onboardingStep: { gt: 5 } }] } }),
]);

const report = {
  duplicateBudgetGroups: duplicateBudgets[0]?.count ?? 0,
  invalidTransfers,
  negativeSavingsGoals,
  overpaidLoans: overpaidLoans[0]?.count ?? 0,
  overpaidObligations: overpaidObligations[0]?.count ?? 0,
  invalidOnboardingSteps,
};
console.log(JSON.stringify({
  ...report,
  legacyUnassignedTransactions: transactionsWithoutWallet,
  integrityIssueCount: Object.values(report).reduce((sum, count) => sum + count, 0),
  warningCount: transactionsWithoutWallet,
}));
await prisma.$disconnect();
