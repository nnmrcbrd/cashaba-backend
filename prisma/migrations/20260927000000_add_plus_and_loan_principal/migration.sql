ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'LOAN_PROCEEDS';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'LOAN_DISBURSEMENT';

CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'PLUS');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "provider" TEXT NOT NULL DEFAULT 'INTERNAL',
    "provider_customer_id" TEXT,
    "provider_subscription_id" TEXT,
    "current_period_start" TIMESTAMP(3) NOT NULL,
    "current_period_end" TIMESTAMP(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsagePeriod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "ai_requests" INTEGER NOT NULL DEFAULT 0,
    "receipt_scans" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsagePeriod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE UNIQUE INDEX "Subscription_provider_subscription_id_key" ON "Subscription"("provider_subscription_id");
CREATE UNIQUE INDEX "UsagePeriod_userId_period_start_key" ON "UsagePeriod"("userId", "period_start");
CREATE UNIQUE INDEX "BillingEvent_provider_event_id_key" ON "BillingEvent"("provider_event_id");
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsagePeriod" ADD CONSTRAINT "UsagePeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
