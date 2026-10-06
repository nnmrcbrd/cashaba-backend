import { businessDate } from "./calendar";
// Calculate every occurrence from its original anchor, so Jan 31 -> Feb 28 -> Mar 31.
export function occurrenceDate(anchor: Date, frequency: string, count = 1): Date {
  const next = businessDate(anchor);
  if (frequency === 'ONE_TIME' || count === 0) return new Date(next.getTime() - 8 * 60 * 60 * 1000);
  if (frequency === 'WEEKLY') { next.setUTCDate(next.getUTCDate() + count * 7); return new Date(next.getTime() - 8 * 60 * 60 * 1000); }
  const months = frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : frequency === 'YEARLY' ? 12 : 0;
  if (!months) throw new Error('Unsupported recurrence frequency');
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months * count);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return new Date(next.getTime() - 8 * 60 * 60 * 1000);
}

export function occurrencesBefore(anchor: Date, frequency: string, end: Date): number {
  if (anchor >= end) return 0;
  if (frequency === 'ONE_TIME') return 1;
  // Binary search avoids looping once per missed installment on old obligations.
  let low = 0, high = 1;
  while (occurrenceDate(anchor, frequency, high) < end) high *= 2;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (occurrenceDate(anchor, frequency, middle) < end) low = middle;
    else high = middle;
  }
  return low + 1;
}
