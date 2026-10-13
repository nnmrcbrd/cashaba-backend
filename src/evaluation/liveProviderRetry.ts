type LiveProviderEvidence = {
  providerAccepted: boolean;
  calls: ReadonlyArray<{ phase: string; responded: boolean }>;
};

// A response rejected by the production guards is still pending live proof.
// Preserve its attempt when retrying; never promote a fallback or embedding.
export function needsLiveProviderRetry(scenario?: LiveProviderEvidence) {
  return !scenario || !scenario.providerAccepted
    || !scenario.calls.some(call => call.phase !== 'embedding' && call.responded);
}
