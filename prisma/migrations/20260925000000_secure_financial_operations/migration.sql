ALTER TABLE "User" ADD COLUMN "local_credential_verified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "google_subject" TEXT,
  ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "User_google_subject_key" ON "User"("google_subject");
CREATE TABLE "FinancialOperation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinancialOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FinancialOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FinancialOperation_userId_key_key" ON "FinancialOperation"("userId", "key");
ALTER TABLE "Loan" ADD COLUMN "schedule_anchor" TIMESTAMP(3);
UPDATE "Loan" SET "schedule_anchor" = "deadline";
ALTER TABLE "FixedExpense" ADD COLUMN "schedule_anchor" TIMESTAMP(3);
UPDATE "FixedExpense" SET "due_date" = "createdAt" WHERE "due_date" IS NULL AND "frequency" <> 'ONE_TIME';
UPDATE "FixedExpense" SET "schedule_anchor" = "due_date";
