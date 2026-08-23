CREATE TABLE IF NOT EXISTS "Wallet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT,
    "account_type" TEXT NOT NULL DEFAULT 'CASH',
    "kind" TEXT NOT NULL DEFAULT 'ASSET',
    "opening_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "icon" TEXT NOT NULL DEFAULT 'wallet',
    "color" TEXT NOT NULL DEFAULT '#0f766e',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Wallet"
    ADD COLUMN IF NOT EXISTS "institution" TEXT,
    ADD COLUMN IF NOT EXISTS "account_type" TEXT NOT NULL DEFAULT 'CASH',
    ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'ASSET',
    ADD COLUMN IF NOT EXISTS "opening_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "wallet_id" TEXT;

CREATE INDEX IF NOT EXISTS "Wallet_userId_idx" ON "Wallet"("userId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Wallet_userId_fkey'
    ) THEN
        ALTER TABLE "Wallet"
            ADD CONSTRAINT "Wallet_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Transaction_wallet_id_fkey'
    ) THEN
        ALTER TABLE "Transaction"
            ADD CONSTRAINT "Transaction_wallet_id_fkey"
            FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
