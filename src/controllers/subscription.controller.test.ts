import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { prisma } from '@/lib/prisma';
import { cancelSubscription } from '@/controllers/subscription.controller';

test('switching demo Plus to Free immediately applies Free limits without resetting usage', async (t) => {
  const existing = {
    userId: 'demo-user', plan: 'PLUS', status: 'ACTIVE', provider: 'DEMO',
    currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 86400000),
    cancelAtPeriodEnd: true, cancelledAt: null,
  };
  let saved = existing;
  const originalSubscription = prisma.subscription;
  const originalUsage = prisma.usagePeriod;
  const originalUser = prisma.user;
  const originalOperations = prisma.financialOperation;
  Object.defineProperty(prisma, 'financialOperation', { configurable: true, value: { findUnique: async () => null } });
  Object.defineProperty(prisma, 'user', { configurable: true, value: { findUniqueOrThrow: async () => ({ trialStartedAt: new Date() }) } });
  Object.defineProperty(prisma, 'subscription', { configurable: true, value: {
    findUnique: async () => saved,
    update: async ({ data }: { data: Partial<typeof existing> }) => {
    saved = { ...saved, ...data };
    return saved;
    },
  } });
  Object.defineProperty(prisma, 'usagePeriod', { configurable: true, value: {
    findUnique: async () => ({ aiRequests: 12, receiptScans: 3 }),
  } });
  t.after(() => {
    Object.defineProperty(prisma, 'financialOperation', { configurable: true, value: originalOperations });
    Object.defineProperty(prisma, 'user', { configurable: true, value: originalUser });
    Object.defineProperty(prisma, 'subscription', { configurable: true, value: originalSubscription });
    Object.defineProperty(prisma, 'usagePeriod', { configurable: true, value: originalUsage });
  });
  let result: { plan: string; cancelAtPeriodEnd: boolean; limits: unknown; used: unknown; remaining: unknown } | undefined;
  const req = { user: { userId: 'demo-user' } } as unknown as Request;
  const res = { json: (body: typeof result) => { result = body; } } as unknown as Response;
  await cancelSubscription(req, res);
  assert.equal(saved.plan, 'FREE');
  assert.equal(saved.status, 'CANCELLED');
  assert.equal(result?.plan, 'FREE');
  assert.equal(result?.cancelAtPeriodEnd, false);
  assert.deepEqual(result?.limits, { aiRequests: 10, receiptScans: 5 });
  assert.deepEqual(result?.used, { aiRequests: 12, receiptScans: 3 });
  assert.deepEqual(result?.remaining, { aiRequests: 0, receiptScans: 2 });
});
