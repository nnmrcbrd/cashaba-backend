ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'BASIC';
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'STANDARD';
ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'PREMIUM';

-- Existing accounts receive their first 14-day trial at rollout.
-- New accounts start once at creation; plan changes never reset this date.
ALTER TABLE "User" ADD COLUMN "trial_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Subscription" ADD COLUMN "requested_plan" "SubscriptionPlan";
ALTER TABLE "Subscription" ADD COLUMN "checkout_amount_cents" INTEGER;
