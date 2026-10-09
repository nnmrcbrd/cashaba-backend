import { CORE_KNOWLEDGE } from './coreConversation';

export const KNOWLEDGE_VERSION = 'casha-guidance-2026-10-v1';
export type Passage = { id: string; source: string; version: string; embeddingVersion: 'none'; text: string };
export function chunkGuidance(source: string, text: string, size = 600, overlap = 80): Passage[] {
  size = Math.max(100, Math.min(1000, size)); overlap = Math.max(0, Math.min(100, overlap, size / 4));
  const passages: Passage[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    passages.push({ id: `${source}:${passages.length}`, source, version: KNOWLEDGE_VERSION, embeddingVersion: 'none', text: text.slice(start, start + size) });
    if (start + size >= text.length) break;
  }
  return passages;
}
export const FINANCIAL_EXPLANATIONS = {
  calendars: 'Savings deadlines count actual contribution dates. Daily and weekly schedules need a start date. Monthly schedules retain the original day and clamp to month end. Payday schedules need confirmed pay dates. School budgets require actual school days and holidays; recorded allowance alone does not establish attendance.',
  affordability: 'Affordability depends on liquid account balances, protected cash, essential daily costs, and bills and debt payments before the next confirmed payday. Goal savings contributions have already left source wallets; do not subtract their balances twice. Future salary and lent money are not cash available today. Missing records do not prove no commitments.',
  interest: 'Debt terms may be interest-free, flat interest on original principal, or reducing interest on outstanding principal. Ask for interest rate per payment period, fees and payment schedule. Principal-only illustrations are not full interest forecasts. A payment no larger than interest and fees does not reduce principal.',
  history: 'Compare equivalent periods: month-to-date against the same elapsed days in the previous month, not a completed month. Forecasts depend on history coverage and are estimates. Recorded categories alone cannot distinguish every essential cost from discretionary spending.',
};
// Only checked-in approved explanations are searchable. User text, transaction
// labels and private figures never enter this index. No embedding API/index is
// required, so an embedding outage cannot stop ledger calculations.
export const GUIDANCE_DOCUMENTS = Object.entries({ ...CORE_KNOWLEDGE, ...FINANCIAL_EXPLANATIONS }).map(([source, text]) => ({ source, text }));
const corpus = GUIDANCE_DOCUMENTS.flatMap(({ source, text }) => chunkGuidance(source, text));
const stop = new Set('a an the to is my me i can how what when for of in and or it this that with do should will much'.split(' '));
const terms = (value: string) => [...new Set((value.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(word => !stop.has(word)).map(word => word.replace(/(?:ing|s)$/, '')))];
// Score is lexical query-term coverage, not vector distance or a probability.
export function retrieveGuidance(query: string, maxChars = 1800, threshold = Number(process.env.AI_RETRIEVAL_THRESHOLD ?? 0.25)) {
  const words = terms(query); if (!words.length) return [];
  const cutoff = Number.isFinite(threshold) ? Math.max(0.1, Math.min(1, threshold)) : 0.25;
  const ranked = corpus.map(passage => ({ ...passage, score: words.filter(word => terms(passage.text).includes(word)).length / words.length }))
    .filter(passage => passage.score >= cutoff).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected: typeof ranked = []; let used = 0;
  for (const passage of ranked) {
    if (selected.length === 3) break;
    if (used + passage.text.length > Math.min(2400, maxChars)) continue;
    selected.push(passage); used += passage.text.length;
  }
  return selected;
}
