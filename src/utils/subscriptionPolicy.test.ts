import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionAccess, PLAN_CATALOG, DAY_MS } from './subscriptionPolicy';

test('trial expires at exactly 14 elapsed days, including across months', () => {
  const start = new Date('2026-01-25T10:30:00Z');
  const end = new Date(start.getTime() + 14 * DAY_MS);
  assert.equal(subscriptionAccess(start, null, start).trialDaysRemaining, 14);
  assert.equal(subscriptionAccess(start, null, new Date(end.getTime() - 1)).canWrite, true);
  const expired = subscriptionAccess(start, null, end);
  assert.equal(expired.accessStatus, 'EXPIRED');
  assert.equal(expired.trialDaysRemaining, 0);
  assert.equal(expired.canWrite, false);
  assert.deepEqual(expired.limits, { aiRequests: 0, receiptScans: 0 });
});
test('each paid tier has its agreed price and limits, and expires at its end', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const start = new Date(now.getTime() - 30 * DAY_MS);
  for (const [plan, priceCents, aiRequests, receiptScans] of [['BASIC', 9900, 50, 20], ['STANDARD', 14900, 200, 100], ['PREMIUM', 19900, 500, 250], ['PLUS', 9900, 200, 100]] as const) {
    assert.equal(PLAN_CATALOG[plan].priceCents, priceCents);
    const sub = { plan, status: 'ACTIVE', currentPeriodEnd: new Date(now.getTime() + DAY_MS) };
    const active = subscriptionAccess(start, sub, now);
    assert.equal(active.plan, plan);
    assert.equal(active.canWrite, true);
    assert.deepEqual(active.limits, { aiRequests, receiptScans });
    assert.equal(subscriptionAccess(start, sub, sub.currentPeriodEnd).accessStatus, 'EXPIRED');
    for (const status of ['CANCELLED', 'PAST_DUE', 'EXPIRED']) assert.equal(subscriptionAccess(start, { ...sub, status }, now).canWrite, false);
  }
});
test('cancellation, downgrade and a new month never restart a used trial', () => {
  const start = new Date('2026-09-01T00:00:00Z'), now = new Date('2026-10-01T00:00:00Z');
  for (const plan of ['FREE', 'BASIC', 'STANDARD', 'PREMIUM']) {
    const access = subscriptionAccess(start, { plan, status: 'CANCELLED', currentPeriodEnd: new Date(now.getTime() + DAY_MS) }, now);
    assert.equal(access.canWrite, false);
    assert.equal(access.trialEndsAt.toISOString(), '2026-09-15T00:00:00.000Z');
  }
});
