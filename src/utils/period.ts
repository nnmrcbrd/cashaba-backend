export type PeriodKey = "week" | "month" | "last-month" | "custom";

export function resolvePeriod(input: {
  period?: string;
  startDate?: string;
  endDate?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const period = (input.period || "month") as PeriodKey;
  if (period === "custom" && input.startDate && input.endDate) {
    const start = new Date(`${input.startDate}T00:00:00`);
    const end = new Date(`${input.endDate}T23:59:59.999`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
      return { start, end, period };
    }
  }
  if (period === "week") {
    const offset = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    return { start, end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - offset), 0, 0, 0, -1), period };
  }
  const monthOffset = period === "last-month" ? -1 : 0;
  const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 1);
  end.setMilliseconds(-1);
  return { start, end, period: period === "last-month" ? period : "month" };
}
