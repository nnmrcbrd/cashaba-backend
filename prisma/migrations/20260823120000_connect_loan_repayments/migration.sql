ALTER TABLE "Loan"
ADD COLUMN "repayment_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "repayment_frequency" TEXT NOT NULL DEFAULT 'ONE_TIME',
ADD COLUMN "amount_paid" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Preserve existing records as one-time obligations using their current due date.
UPDATE "Loan"
SET "repayment_amount" = "amount"
WHERE "repayment_amount" = 0;

ALTER TABLE "Transaction" ADD COLUMN "loan_id" TEXT;

CREATE INDEX "Transaction_loan_id_idx" ON "Transaction"("loan_id");

ALTER TABLE "Transaction"
ADD CONSTRAINT "Transaction_loan_id_fkey"
FOREIGN KEY ("loan_id") REFERENCES "Loan"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
