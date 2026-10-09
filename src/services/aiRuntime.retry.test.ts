import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBounded, retryDelay } from './aiRuntime';

test('Gemini quota RetryInfo prevents a repeated call before the quota recovers', async () => {
  const error = Object.assign(new Error(JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '46s' },
  ] } })), { status: 429 });
  assert.equal(retryDelay(error, 0, 0), 46000);
  let calls = 0, reservations = 0;
  const start = Date.now();
  await assert.rejects(generateBounded({ contents: 'Synthetic quota test' }, {
    reserve: async () => { reservations++; }, generate: async () => { calls++; throw error; },
  }), error);
  assert.equal(calls, 1);
  assert.equal(reservations, 1);
  assert.ok(Date.now() - start < 5000, 'Return fallback rather than waiting past the request deadline');
});

test('invalid RetryInfo and Retry-After dates do not disable bounded backoff', () => {
  for (const message of ['not JSON', '{"error":{"details":[{"retryDelay":"999s"}]}}', '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"Infinitys"}]}}']) {
    assert.equal(retryDelay({ message, headers: { 'retry-after': 'invalid-date' } }, 0, 0), 250);
  }
});
