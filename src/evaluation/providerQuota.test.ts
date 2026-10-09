import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyProviderQuota } from './providerQuota';

test('daily quota classification retains the provider retry interval and safe quota fields', () => {
  const error = Object.assign(new Error(JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{
      quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '500',
      quotaDimensions: { model: 'gemini-3.5-flash-lite', secret: 'not retained' },
    }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56820s' },
  ] } })), { status: 429 });
  assert.deepEqual(dailyProviderQuota(error), {
    quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: 500,
    model: 'gemini-3.5-flash-lite', retrySeconds: 56820,
  });
});

test('minute throttling, malformed diagnostics and unavailable providers are not daily quota evidence', () => {
  for (const error of [null, { status: 429, message: 'Quota exceeded' },
    { status: 503, message: '{"error":{"details":[]}}' },
    { status: 429, message: JSON.stringify({ error: { details: [{
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProject', quotaValue: '15' }],
    }] } }) },
    { status: 429, message: '{"error":{"details":[{"violations":[{"quotaId":"PerDay"}]}]}}' },
  ]) assert.equal(dailyProviderQuota(error), null);
});
