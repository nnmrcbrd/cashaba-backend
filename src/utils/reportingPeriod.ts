import { businessDate, businessMidnight } from './calendar';
export function reportMonths(start: Date, end: Date) {
  const result: Array<{ month: number; year: number; fraction: number }> = [];
  const first = businessDate(start);
  for (let cursor = businessMidnight(first.getUTCFullYear(), first.getUTCMonth()); cursor <= end;) {
    const local = businessDate(cursor);
    const next = businessMidnight(local.getUTCFullYear(), local.getUTCMonth() + 1);
    const overlap = Math.min(end.getTime() + 1, next.getTime()) - Math.max(start.getTime(), cursor.getTime());
    result.push({ month: local.getUTCMonth() + 1, year: local.getUTCFullYear(), fraction: overlap / (next.getTime() - cursor.getTime()) });
    cursor = next;
  }
  return result;
}
export function periodForecast(expenses: number, start: Date, end: Date, now = new Date()) {
  if (now >= end) return expenses;
  const days = Math.max(1, Math.ceil((end.getTime() + 1 - start.getTime()) / 86_400_000));
  const elapsed = Math.min(days, Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86_400_000)));
  return Math.round(expenses / elapsed * days * 100) / 100;
}
