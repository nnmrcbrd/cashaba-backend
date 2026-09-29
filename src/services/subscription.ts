import { prisma, qualifiedTable } from '@/lib/prisma';

export type UsageMetric = 'aiRequests' | 'receiptScans';
export const PLAN_LIMITS = {
  FREE: { aiRequests: 10, receiptScans: 5 },
  PLUS: { aiRequests: 200, receiptScans: 100 },
} as const;

export class UsageLimitError extends Error {
  status = 429;
  constructor(public metric: UsageMetric, public limit: number) {
    super(`Monthly ${metric === 'aiRequests' ? 'AI request' : 'receipt scan'} limit reached. Upgrade to Casha-Ba Plus or wait for the next billing period.`);
  }
}

export function monthlyPeriod(now = new Date()) {
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart, periodEnd };
}

function activePlan(subscription: { plan: 'FREE' | 'PLUS'; status: string; currentPeriodEnd: Date } | null, now: Date) {
  return subscription?.plan === 'PLUS' && subscription.status === 'ACTIVE' && subscription.currentPeriodEnd > now ? 'PLUS' as const : 'FREE' as const;
}

export async function getSubscriptionSummary(userId: string, now = new Date()) {
  const { periodStart, periodEnd } = monthlyPeriod(now);
  const [subscription, usage] = await Promise.all([
    prisma.subscription.findUnique({ where: { userId } }),
    prisma.usagePeriod.findUnique({ where: { userId_periodStart: { userId, periodStart } } }),
  ]);
  const plan = activePlan(subscription, now);
  const limits = PLAN_LIMITS[plan];
  const used = { aiRequests: usage?.aiRequests ?? 0, receiptScans: usage?.receiptScans ?? 0 };
  return {
    plan,
    status: subscription?.status ?? 'ACTIVE',
    provider: subscription?.provider ?? 'INTERNAL',
    currentPeriodStart: subscription?.currentPeriodStart ?? periodStart,
    currentPeriodEnd: subscription?.currentPeriodEnd ?? periodEnd,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    paymentPending: subscription?.provider === 'PAYMONGO' && subscription.plan === 'FREE' && subscription.status === 'ACTIVE' && Boolean(subscription.providerSubscriptionId),
    providerActionRequired: subscription?.provider === 'PAYMONGO' && Boolean(subscription.providerSubscriptionId) && !['CANCELLED', 'EXPIRED'].includes(subscription.status) && plan === 'FREE',
    used,
    limits,
    remaining: { aiRequests: Math.max(0, limits.aiRequests - used.aiRequests), receiptScans: Math.max(0, limits.receiptScans - used.receiptScans) },
    demoAvailable: process.env.NODE_ENV !== 'production' && (process.env.BILLING_MODE ?? 'demo') === 'demo',
  };
}

export async function consumeUsage(userId: string, metric: UsageMetric) {
  const now = new Date();
  const { periodStart, periodEnd } = monthlyPeriod(now);
  return prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT "id" FROM ${qualifiedTable('User')} WHERE "id" = $1 FOR UPDATE`, userId);
    const subscription = await tx.subscription.findUnique({ where: { userId } });
    const plan = activePlan(subscription, now);
    const limit = PLAN_LIMITS[plan][metric];
    const usage = await tx.usagePeriod.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      create: { userId, periodStart, periodEnd },
      update: { periodEnd },
    });
    if (usage[metric] >= limit) throw new UsageLimitError(metric, limit);
    return tx.usagePeriod.update({ where: { id: usage.id }, data: { [metric]: { increment: 1 } } });
  });
}

export async function refundUsage(userId: string, metric: UsageMetric, usagePeriodId: string) {
  await prisma.usagePeriod.updateMany({
    where: { id: usagePeriodId, userId, [metric]: { gt: 0 } },
    data: { [metric]: { decrement: 1 } },
  });
}
