import type { Decimal } from "@/generated/prisma/internal/prismaNamespace";

export type MoneyValue = Decimal | number | string | null | undefined | unknown;
export const WEEKS_PER_MONTH = 52 / 12;

export function money(value: MoneyValue): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function moneyFields<T extends Record<string, unknown>>(
  record: T,
  fields: Array<keyof T>,
): T {
  const normalized = { ...record };
  for (const field of fields) normalized[field] = money(record[field] as MoneyValue) as T[keyof T];
  return normalized;
}
