// Reporting uses Philippine calendar days, independently of the server timezone.
export const FINANCIAL_TIMEZONE = 'Asia/Manila';
const OFFSET_MS = 8 * 60 * 60 * 1000;
export function businessDate(now = new Date()) {
  return new Date(now.getTime() + OFFSET_MS);
}
export function businessDateLabel(now = new Date()) {
  return businessDate(now).toISOString().slice(0, 10);
}
export function businessMidnight(year: number, monthIndex: number, day = 1) {
  return new Date(Date.UTC(year, monthIndex, day) - OFFSET_MS);
}
export function businessMonth(now = new Date()) {
  const date = businessDate(now);
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;
  return { year, month, start: businessMidnight(year, month - 1), end: businessMidnight(year, month) };
}
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
// Preserve UTC date-only storage used by existing forms/imports. ISO timestamps
// remain instants, but their date prefix must also be an actual calendar date.
export function isFinancialDate(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  return typeof value === 'string' && isCalendarDate(value.slice(0, 10)) &&
    (value.length === 10 || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) &&
    Number.isFinite(new Date(value).getTime());
}
