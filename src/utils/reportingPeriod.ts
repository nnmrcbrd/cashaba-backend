export function reportMonths(start: Date, end: Date) {
  const result: Array<{ month: number; year: number; fraction: number }> = [];
  for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const overlap = Math.min(end.getTime() + 1, next.getTime()) - Math.max(start.getTime(), cursor.getTime());
    result.push({ month: cursor.getMonth() + 1, year: cursor.getFullYear(), fraction: overlap / (next.getTime() - cursor.getTime()) });
  }
  return result;
}
export function periodForecast(expenses: number, start: Date, end: Date, now = new Date()) {
  if (now >= end) return expenses;
  const days = Math.max(1, Math.ceil((end.getTime() + 1 - start.getTime()) / 86_400_000));
  const elapsed = Math.min(days, Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86_400_000)));
  return Math.round(expenses / elapsed * days * 100) / 100;
}
