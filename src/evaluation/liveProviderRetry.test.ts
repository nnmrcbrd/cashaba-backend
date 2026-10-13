import test from 'node:test';
import assert from 'node:assert/strict';
import { needsLiveProviderRetry } from './liveProviderRetry';

test('an answered but rejected provider result remains pending rather than being skipped on resume', () => {
  assert.equal(needsLiveProviderRetry({ providerAccepted: false, calls: [{ phase: 'extraction', responded: true }, { phase: 'explanation', responded: true }] }), true);
});

test('an embedding and failed generation never substitute for live generation proof', () => {
  assert.equal(needsLiveProviderRetry({ providerAccepted: true, calls: [{ phase: 'embedding', responded: true }, { phase: 'explanation', responded: false }] }), true);
  assert.equal(needsLiveProviderRetry(), true);
});

test('an accepted generated result is retained without repeated provider calls', () => {
  assert.equal(needsLiveProviderRetry({ providerAccepted: true, calls: [{ phase: 'embedding', responded: true }, { phase: 'explanation', responded: true }] }), false);
});
