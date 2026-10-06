import { businessDate, businessMidnight, isCalendarDate } from './calendar';
export type PeriodKey = "week" | "month" | "last-month" | "custom";

export function resolvePeriod(input: {
  period?: string;
  startDate?: string;
  endDate?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const date = businessDate(now);
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
  const period = (input.period || "month") as PeriodKey;
  if (!['week', 'month', 'last-month', 'custom'].includes(period) || (period === 'custom' && (!input.startDate || !input.endDate))) throw new Error('INVALID_REPORTING_PERIOD');
  if (period === "custom" && input.startDate && input.endDate) {
    const start = new Date(`${input.startDate}T00:00:00+08:00`);
    const end = new Date(`${input.endDate}T23:59:59.999+08:00`);
    if (isCalendarDate(input.startDate) && isCalendarDate(input.endDate) && start <= end) {
      return { start, end, period };
    }
    throw new Error('INVALID_REPORTING_PERIOD');
  }
  if (period === "week") {
    const offset = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
    return { start: businessMidnight(year, month, day - offset), end: new Date(businessMidnight(year, month, day - offset + 7).getTime() - 1), period };
  }
  const monthOffset = period === "last-month" ? -1 : 0;
  const start = businessMidnight(year, month + monthOffset);
  const end = businessMidnight(year, month + monthOffset + 1);
  end.setMilliseconds(-1);
  return { start, end, period: period === "last-month" ? period : "month" };
}
