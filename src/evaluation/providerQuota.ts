// A daily project/model quota needs a later run, rather than minute-level cooldowns.
// Retain only quota diagnostics; never persist the SDK error or request credentials.
export function dailyProviderQuota(error: unknown) {
  const source = error as { status?: unknown; message?: unknown } | null;
  if (Number(source?.status) !== 429 || typeof source?.message !== 'string') return null;
  try {
    const payload = JSON.parse(source.message);
    const details = payload?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const detail of details) {
      if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.QuotaFailure' || !Array.isArray(detail.violations)) continue;
      for (const violation of detail.violations) {
        if (typeof violation?.quotaId !== 'string' || !/PerDay/i.test(violation.quotaId)) continue;
        const retry = details.find(item => item?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
        const seconds = typeof retry?.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/.test(retry.retryDelay)
          ? Number(retry.retryDelay.slice(0, -1)) : NaN;
        const limit = Number(violation.quotaValue);
        return {
          quotaId: violation.quotaId.slice(0, 200),
          quotaValue: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
          model: typeof violation.quotaDimensions?.model === 'string' ? violation.quotaDimensions.model.slice(0, 100) : null,
          retrySeconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= 31_536_000 ? seconds : null,
        };
      }
    }
  } catch { /* An unstructured error is not evidence of a daily quota. */ }
  return null;
}
