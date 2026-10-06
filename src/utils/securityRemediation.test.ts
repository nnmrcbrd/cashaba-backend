import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { budgetInputSchema, buildBudgetSuggestion, validateBudgetProposal, WEEKS_PER_MONTH } from './budgetSuggestion';
import { isCalendarDate, isFinancialDate, businessDateLabel, businessMidnight } from './calendar';
import { parseReceiptModelResponse } from './receiptScan';
import { parseGCashImageText } from './gcashParser';
import { aliasFinancialContext, redactIdentifiers, safeQualitativeReply, isAdviceBoundaryRequest } from './aiSafety';
import { verifyPayMongoSignature } from '@/services/paymongo';
import { protectCookieMutation } from '@/middlewares/csrf.middleware';
import { periodRange } from './safeToSpend';
import { resolvePeriod } from './period';

test('budget rejects malformed income, fractional cents and unsupported periods', () => {
  for (const income of ['not-a-number', 'Infinity', -1, 0, 0.001, true, {}, null]) assert.equal(budgetInputSchema.safeParse({ income, period: 'monthly' }).success, false);
  assert.equal(budgetInputSchema.safeParse({ income: 100, period: 'daily' }).success, false);
  assert.equal(budgetInputSchema.safeParse({ income: '100.25', period: 'weekly' }).success, true);
});
test('budget never overspends even for tiny incomes or rounding boundaries', () => {
  for (const period of ['weekly', 'monthly'] as const) for (const income of [0.01, 0.07, 7, 19.99, 1000.01, 30000]) {
    const plan = buildBudgetSuggestion(income, period);
    const monthly = Math.round(income * 100 * (period === 'weekly' ? WEEKS_PER_MONTH : 1));
    const allocated = plan.fixedExpenses.reduce((s, i) => s + Math.round(i.amount * 100), 0) + plan.savingsGoals.reduce((s, i) => s + Math.round(i.monthlyAllocation * 100), 0) + Math.round(plan.weeklyAllowance * 100) * WEEKS_PER_MONTH;
    assert.ok(allocated <= monthly + 0.0001);
    assert.ok(validateBudgetProposal(plan, income, period));
  }
});
test('model budget validation rejects unaffordable, negative and incomplete proposals', () => {
  const plan = buildBudgetSuggestion(1000, 'monthly');
  assert.equal(validateBudgetProposal({ ...plan, weeklyAllowance: 1000 }, 1000, 'monthly'), null);
  assert.equal(validateBudgetProposal({ ...plan, fixedExpenses: [{ name: 'Rent', amount: -1 }] }, 1000, 'monthly'), null);
  assert.equal(validateBudgetProposal({ ...plan, savingsGoals: undefined }, 1000, 'monthly'), null);
});
test('financial dates reject rollover, locale ambiguity and invalid timestamps', () => {
  for (const value of ['2026-02-30', '2025-02-29', '09/02/2026', '2026-04-31T12:00:00Z']) assert.equal(isFinancialDate(value), false);
  assert.equal(isCalendarDate('2028-02-29'), true);
  assert.equal(isFinancialDate('2026-10-02T12:30:00+08:00'), true);
});
test('receipt unknown fields stay unknown and incoming fallback is not an expense', () => {
  const parsed = parseReceiptModelResponse(JSON.stringify({ amount: 100, description: 'Shop', date: null, category: 'Others', transactionType: null }));
  assert.equal(parsed?.date, null);
  assert.equal(parsed?.transactionType, null);
  assert.equal(parseReceiptModelResponse(JSON.stringify({ ...parsed, date: '2026-02-30' })), null);
  const incoming = parseGCashImageText('Received from Example PHP 100.00');
  assert.equal(incoming?.date, null);
  assert.equal(incoming?.transactionType, 'INCOME');
  assert.equal(parseGCashImageText('PHP 100.00')?.transactionType, null);
});
test('reporting switches to the new Manila month while UTC is still the previous day', () => {
  const now = new Date('2026-09-30T16:01:00Z');
  const range = periodRange('monthly', now);
  assert.equal(range.start.toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-31T16:00:00.000Z');
  assert.equal(businessDateLabel(now), '2026-10-01');
  const custom = resolvePeriod({ period: 'custom', startDate: '2026-10-01', endDate: '2026-10-02' });
  assert.equal(custom.start.toISOString(), businessMidnight(2026, 9).toISOString());
  assert.throws(() => resolvePeriod({ period: 'custom', startDate: '2026-02-30', endDate: '2026-03-01' }));
});
test('AI aliasing preserves the local names and does not redact dates or financial amounts', () => {
  const aliases = aliasFinancialContext(JSON.stringify({ wallets: [{ name: 'Personal Cash' }], loans: [{ title: 'Owe Example' }] }));
  const sanitized = aliases.sanitize('Use Personal Cash on 2026-10-02 for PHP 1234.56; email user@example.test');
  assert.ok(!sanitized.includes('Personal Cash'));
  assert.ok(!sanitized.includes('user@example.test'));
  assert.ok(sanitized.includes('2026-10-02'));
  assert.ok(sanitized.includes('1234.56'));
  assert.ok(aliases.restore(sanitized).includes('Personal Cash'));
  assert.ok(!redactIdentifiers('Phone +639171234567; account number 123456789012').includes('123456789012'));
});
test('AI numerical claims fall back; qualitative budgeting remains available', () => {
  assert.equal(safeQualitativeReply('You can spend ₱90000.'), null);
  assert.equal(safeQualitativeReply('Guaranteed returns are available.'), null);
  assert.ok(safeQualitativeReply('Review essential bills before increasing discretionary spending.'));
  assert.equal(isAdviceBoundaryRequest('Which stock should I buy?'), true);
  assert.equal(isAdviceBoundaryRequest('How do I budget for groceries?'), false);
});
test('AI entity aliases replace full names without corrupting Casha-Ba or another account name', () => {
  const aliases = aliasFinancialContext(JSON.stringify({ wallets: [{ name: 'Cash' }] }));
  assert.equal(aliases.sanitize('Use Cash in Casha-Ba; GCash is another account.'), 'Use CASHA_ENTITY_1 in Casha-Ba; GCash is another account.');
});
test('cookie mutations reject foreign origins before executing the handler', () => {
  const original = process.env.FRONTEND_URL;
  try {
    process.env.FRONTEND_URL = 'https://app.example.test';
    for (const [origin, metadata, allowed] of [['https://evil.test', '', false], ['https://app.example.test', 'cross-site', true], ['', 'cross-site', false], ['', '', true]]) {
      let next = false, status = 0;
      const req = { get: (key: string) => key === 'Origin' ? origin : metadata } as Request;
      const res = { status: (value: number) => { status = value; return res; }, json: () => res } as unknown as Response;
      protectCookieMutation(req, res, () => { next = true; });
      assert.equal(next, allowed);
      if (!allowed) assert.equal(status, 403);
    }
  } finally { if (original === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = original; }
});
test('PayMongo verifies timestamped signatures, mode and raw bytes; rejects stale/replayed headers', () => {
  const saved = { secret: process.env.PAYMONGO_WEBHOOK_SECRET, legacy: process.env.PAYMONGO_ALLOW_LEGACY_SIGNATURE };
  try {
    process.env.PAYMONGO_WEBHOOK_SECRET = 'synthetic-test-only';
    delete process.env.PAYMONGO_ALLOW_LEGACY_SIGNATURE;
    const raw = Buffer.from(JSON.stringify({ data: { attributes: { livemode: false } } }));
    const signed = (seconds: number) => { const t = String(seconds); return `t=${t},te=${createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(t + '.').update(raw).digest('hex')},li=`; };
    const now = Math.floor(Date.now() / 1000), signature = signed(now);
    assert.equal(verifyPayMongoSignature(raw, signature), true);
    assert.equal(verifyPayMongoSignature(Buffer.from(raw.toString() + ' '), signature), false);
    assert.equal(verifyPayMongoSignature(raw, signed(now - 301)), false);
    assert.equal(verifyPayMongoSignature(raw, signature.replace('te=', 'li=')), false);
    assert.equal(verifyPayMongoSignature(raw, signature + ',t=' + now), false);
    const bare = createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET!).update(raw).digest('hex');
    assert.equal(verifyPayMongoSignature(raw, bare), false);
    process.env.PAYMONGO_ALLOW_LEGACY_SIGNATURE = 'true';
    assert.equal(verifyPayMongoSignature(raw, bare), true);
  } finally {
    for (const [key, value] of [['PAYMONGO_WEBHOOK_SECRET', saved.secret], ['PAYMONGO_ALLOW_LEGACY_SIGNATURE', saved.legacy]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
