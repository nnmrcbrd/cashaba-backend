// Minimize obvious identifiers. This is not a complete PII detector; images and
// arbitrary user prose still require point-of-use notice and provider review.
export function redactIdentifiers(text: string) {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?<!\w)(?:\+63[ -]?\d(?:[ -]?\d){9}|09(?:[ -]?\d){9})(?!\w)/g, '[phone]')
    .replace(/\b(?:account|acct|card)\s*(?:number|no\.?)?\s*[:#]?\s*\d(?:[ -]?\d){7,18}/gi, '[account identifier]');
}
export function aliasFinancialContext(context: string, extraNames: string[] = []) {
  const names = [...extraNames];
  try {
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
        if (['name', 'title'].includes(key) && typeof entry === 'string') names.push(entry);
        else visit(entry);
      }
    };
    visit(JSON.parse(context));
  } catch { /* local fallback context has no aliases */ }
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const aliases = unique.map((name, index) => ({ name, token: `CASHA_ENTITY_${index + 1}` }));
  const pattern = aliases.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${aliases.map(item => item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  return {
    sanitize(text: string) {
      return redactIdentifiers(pattern ? text.replace(pattern, name => aliases.find(item => item.name.toLowerCase() === name.toLowerCase())!.token) : text);
    },
    restore(text: string) {
      return text.replace(/CASHA_ENTITY_\d+/g, token => aliases.find(item => item.token === token)?.name ?? token);
    },
  };
}
const unsafeAdvice = /guaranteed?\s+(?:profit|return)|risk[- ]free|(?:buy|sell|invest\s+in)\s+(?:stocks?|shares?|crypto|bitcoin|securities)|(?:bumili|mag-invest)\s+(?:ng|sa)\s+(?:stock|crypto|bitcoin)/i;
export function isAdviceBoundaryRequest(text: string) {
  return /\b(?:which|should|recommend|best|buy|sell|pick)\b.{0,80}\b(?:stocks?|shares?|crypto|bitcoin|securities|investment)\b|\bguaranteed?\s+(?:profit|return)\b|\b(?:anong|aling|dapat|bumili|mag-invest)\b.{0,80}\b(?:stock|crypto|bitcoin|investment)\b/i.test(text);
}
export function safeQualitativeReply(value: unknown): string | null {
  // Numeric claims are rendered by deterministic financial summaries instead.
  if (typeof value !== 'string' || !value.trim() || value.length > 1200 || /\d|[₱$€£%]/.test(value) || unsafeAdvice.test(value)) return null;
  return value.trim();
}
export const ADVICE_BOUNDARY_REPLY = 'I can explain budgeting, savings, debts and your recorded finances. I cannot recommend specific securities or promise investment returns. For personal investment decisions, consult an appropriately qualified adviser.';
