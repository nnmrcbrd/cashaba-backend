export const TRIAL_DAYS = 14;
export const DAY_MS = 86_400_000;
export const PLAN_CATALOG = {
  BASIC: { name: 'Basic', priceCents: 9900, aiRequests: 50, receiptScans: 20 },
  STANDARD: { name: 'Standard', priceCents: 14900, aiRequests: 200, receiptScans: 100 },
  PREMIUM: { name: 'Premium', priceCents: 19900, aiRequests: 500, receiptScans: 250 },
  // Preserve existing Plus entitlements and previously issued checkout prices.
  PLUS: { name: 'Plus (legacy)', priceCents: 9900, aiRequests: 200, receiptScans: 100 },
} as const;
export type PaidPlan = keyof typeof PLAN_CATALOG;
export type SubscriptionPlan = 'FREE' | PaidPlan;
export const PLAN_LIMITS = {
  FREE: { aiRequests: 10, receiptScans: 5 },
  ...Object.fromEntries(Object.entries(PLAN_CATALOG).map(([id, plan]) => [id, { aiRequests: plan.aiRequests, receiptScans: plan.receiptScans }])),
} as Record<SubscriptionPlan, { aiRequests: number; receiptScans: number }>;
export function isPaidPlan(plan: string | null | undefined): plan is PaidPlan {
  return Boolean(plan && Object.hasOwn(PLAN_CATALOG, plan));
}
export function subscriptionAccess(trialStartedAt: Date, subscription: { plan: string; status: string; currentPeriodEnd: Date } | null, now = new Date()) {
  const trialEndsAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * DAY_MS);
  const trialDaysRemaining = Math.max(0, Math.min(TRIAL_DAYS, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS)));
  const paid = subscription && isPaidPlan(subscription.plan) && subscription.status === 'ACTIVE' && subscription.currentPeriodEnd > now;
  const plan: SubscriptionPlan = paid ? subscription.plan as PaidPlan : 'FREE';
  const accessStatus = paid ? 'ACTIVE' : trialEndsAt > now ? 'TRIAL' : 'EXPIRED';
  return {
    plan, planName: plan === 'FREE' ? accessStatus === 'TRIAL' ? '14-day trial' : 'Trial expired' : PLAN_CATALOG[plan].name,
    accessStatus, canWrite: accessStatus !== 'EXPIRED', trialStartedAt, trialEndsAt, trialDaysRemaining,
    limits: accessStatus === 'EXPIRED' ? { aiRequests: 0, receiptScans: 0 } : PLAN_LIMITS[plan],
  };
}
