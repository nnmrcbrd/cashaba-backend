CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "ObligationFrequency" AS ENUM ('ONE_TIME', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'COMPLETED');
CREATE TYPE "AiSessionState" AS ENUM ('COMPLETED', 'NEEDS_CLARIFICATION', 'AWAITING_CONFIRMATION', 'CANCELLED');

ALTER TYPE "TransactionType" ADD VALUE 'TRANSFER';
ALTER TYPE "TransactionType" ADD VALUE 'ADJUSTMENT';
ALTER TYPE "TransactionType" ADD VALUE 'SAVINGS_CONTRIBUTION';
ALTER TYPE "TransactionType" ADD VALUE 'SAVINGS_WITHDRAWAL';
ALTER TYPE "TransactionType" ADD VALUE 'BILL_PAYMENT';
ALTER TYPE "TransactionType" ADD VALUE 'DEBT_PAYMENT';
ALTER TYPE "TransactionType" ADD VALUE 'LOAN_COLLECTION';

DROP INDEX IF EXISTS "Budget_userId_month_year_idx";

ALTER TABLE "AiSession"
  ADD COLUMN "pending_action" JSONB,
  ADD COLUMN "state" "AiSessionState" NOT NULL DEFAULT 'COMPLETED';

ALTER TABLE "Budget"
  ALTER COLUMN "target_amount" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "amount_spent" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "FixedExpense"
  ADD COLUMN "amount_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'Bills',
  ADD COLUMN "frequency" "ObligationFrequency" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "reminder_days" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "wallet_id" TEXT,
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "IncomeSetup"
  ALTER COLUMN "total_income" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "safe_to_spend" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "Loan"
  ADD COLUMN "installment_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "repayment_amount" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "amount_paid" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "SavingsGoal"
  ALTER COLUMN "target_amount" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "current_amount" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "monthly_allocation" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "Transaction"
  ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "destination_wallet_id" TEXT,
  ADD COLUMN "fixed_expense_id" TEXT,
  ADD COLUMN "savings_goal_id" TEXT,
  ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "User"
  ADD COLUMN "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "custom_role" TEXT,
  ADD COLUMN "last_active_at" TIMESTAMP(3),
  ADD COLUMN "onboarding_completed_at" TIMESTAMP(3),
  ADD COLUMN "onboarding_step" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "region" TEXT;

-- Resume existing users at the furthest setup step already represented by
-- their saved data. A configured monthly budget is treated as completion.
UPDATE "User" AS u
SET
  "onboarding_step" = CASE
    WHEN EXISTS (SELECT 1 FROM "Budget" b WHERE b."userId" = u."id") THEN 5
    WHEN EXISTS (SELECT 1 FROM "FixedExpense" f WHERE f."userId" = u."id") THEN 4
    WHEN EXISTS (SELECT 1 FROM "IncomeSetup" i WHERE i."userId" = u."id") THEN 3
    WHEN cardinality(u."roles") > 0 THEN 2
    ELSE 1
  END,
  "onboarding_completed_at" = CASE
    WHEN EXISTS (SELECT 1 FROM "Budget" b WHERE b."userId" = u."id") THEN CURRENT_TIMESTAMP
    ELSE NULL
  END;

ALTER TABLE "Wallet" ALTER COLUMN "opening_balance" SET DATA TYPE DECIMAL(14,2);

CREATE TABLE "BudgetCategory" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "limit_amount" DECIMAL(14,2) NOT NULL,
  "budgetId" TEXT NOT NULL,
  CONSTRAINT "BudgetCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TransactionAudit" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "transactionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "TransactionAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdminAuditLog" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT NOT NULL,
  CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BudgetCategory_budgetId_category_key" ON "BudgetCategory"("budgetId", "category");
CREATE INDEX "TransactionAudit_transactionId_createdAt_idx" ON "TransactionAudit"("transactionId", "createdAt");
CREATE INDEX "AdminAuditLog_actorId_createdAt_idx" ON "AdminAuditLog"("actorId", "createdAt");
CREATE UNIQUE INDEX "Budget_userId_month_year_key" ON "Budget"("userId", "month", "year");
CREATE INDEX "Transaction_destination_wallet_id_idx" ON "Transaction"("destination_wallet_id");
CREATE INDEX "Transaction_savings_goal_id_idx" ON "Transaction"("savings_goal_id");
CREATE INDEX "Transaction_fixed_expense_id_idx" ON "Transaction"("fixed_expense_id");

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_destination_wallet_id_fkey" FOREIGN KEY ("destination_wallet_id") REFERENCES "Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_savings_goal_id_fkey" FOREIGN KEY ("savings_goal_id") REFERENCES "SavingsGoal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_fixed_expense_id_fkey" FOREIGN KEY ("fixed_expense_id") REFERENCES "FixedExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BudgetCategory" ADD CONSTRAINT "BudgetCategory_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FixedExpense" ADD CONSTRAINT "FixedExpense_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TransactionAudit" ADD CONSTRAINT "TransactionAudit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransactionAudit" ADD CONSTRAINT "TransactionAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
