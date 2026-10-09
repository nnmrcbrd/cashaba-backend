-- Keep historical installment amounts when a user corrects an estimated bill.
ALTER TABLE "FixedExpense" ADD COLUMN "amount_schedule" JSONB NOT NULL DEFAULT '[]';
