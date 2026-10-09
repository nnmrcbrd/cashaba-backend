import { z } from 'zod';
import { isCalendarDate } from './calendar';

// All authoritative arithmetic uses integer centavos. Inputs with fractional
// centavos or amounts outside the ledger's Decimal(14,2) range fail closed.
export const peso = z.number().finite().min(0).max(999_999_999_999.99)
  .refine(value => Math.abs(value - Math.round(value * 100) / 100) <= Number.EPSILON * Math.max(1, value), 'Use whole centavos');
export function cents(value: number): number { return Math.round(peso.parse(value) * 100); }
export function pesos(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('MONEY_OVERFLOW');
  return value / 100;
}
export const calendarDay = z.string().refine(isCalendarDate, 'Use a real YYYY-MM-DD date');
export const scheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'payday']),
  first: calendarDay,
  // Payday is an explicit list, never a guessed twice-monthly schedule.
  paydays: z.array(calendarDay).max(366).optional(),
}).strict();
export type Schedule = z.infer<typeof scheduleSchema>;
const DAY = 86_400_000;
export function addMonths(day: string, count: number): string {
  calendarDay.parse(day);
  const date = new Date(day + 'T00:00:00Z');
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + count;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), last))).toISOString().slice(0, 10);
}
export function contributionDates(schedule: Schedule, until: string, max = 3660): string[] {
  scheduleSchema.parse(schedule); calendarDay.parse(until);
  if (schedule.frequency === 'payday') return [...new Set(schedule.paydays ?? [])].filter(d => d >= schedule.first && d <= until).sort();
  const dates: string[] = [];
  for (let i = 0; i < max; i++) {
    const date = schedule.frequency === 'monthly' ? addMonths(schedule.first, i)
      : new Date(Date.parse(schedule.first + 'T00:00:00Z') + i * DAY * (schedule.frequency === 'weekly' ? 7 : 1)).toISOString().slice(0, 10);
    if (date > until) return dates;
    dates.push(date);
  }
  throw new Error('SCHEDULE_TOO_LONG');
}
export function daysBetween(from: string, until: string): number {
  calendarDay.parse(from); calendarDay.parse(until);
  return Math.max(0, Math.round((Date.parse(until) - Date.parse(from)) / DAY));
}
export function goalTimeline(target: number, saved: number, contribution: number, schedule?: Schedule, skipped = 0) {
  peso.parse(contribution);
  z.number().int().min(0).max(1200).parse(skipped);
  const remaining = Math.max(0, cents(target) - cents(saved));
  const periods = remaining === 0 ? 0 : contribution > 0 ? Math.ceil(remaining / cents(contribution)) : null;
  let completionDate: string | null = null;
  if (schedule && periods != null && periods > 0 && periods + skipped <= 1200) {
    scheduleSchema.parse(schedule);
    const index = periods - 1 + skipped;
    completionDate = schedule.frequency === 'payday' ? [...new Set(schedule.paydays ?? [])].filter(d => d >= schedule.first).sort()[index] ?? null
      : schedule.frequency === 'monthly' ? addMonths(schedule.first, index)
      : new Date(Date.parse(schedule.first) + index * DAY * (schedule.frequency === 'weekly' ? 7 : 1)).toISOString().slice(0, 10);
  }
  return { remaining: pesos(remaining), periods, completionDate };
}
export function requiredContribution(target: number, saved: number, count: number) {
  if (!Number.isInteger(count) || count <= 0) return null;
  return pesos(Math.ceil(Math.max(0, cents(target) - cents(saved)) / count));
}

export const debtTermsSchema = z.object({
  principal: peso, payment: peso, feePerPeriod: peso.default(0),
  interestType: z.enum(['interest_free', 'flat', 'reducing']),
  rateBpsPerPeriod: z.number().int().min(0).max(100_000).default(0),
}).strict();
// Interest is rounded up to centavos per stated payment period. Fees are per
// period. Flat interest is charged on original principal; reducing on balance.
export function debtPayoff(input: z.input<typeof debtTermsSchema>) {
  const terms = debtTermsSchema.parse(input);
  const original = cents(terms.principal), payment = cents(terms.payment), fee = cents(terms.feePerPeriod);
  let balance = original, total = 0, interest = 0;
  for (let periods = 0; periods < 1200; periods++) {
    if (balance === 0) return { periods, total: pesos(total), interest: pesos(interest), doesNotAmortize: false };
    const base = terms.interestType === 'flat' ? original : balance;
    const charge = terms.interestType === 'interest_free' ? 0 : Number((BigInt(base) * BigInt(terms.rateBpsPerPeriod) + 9999n) / 10000n);
    if (payment <= charge + fee) return { periods: null, total: null, interest: null, doesNotAmortize: true };
    const actual = Math.min(payment, balance + charge + fee);
    balance -= actual - charge - fee; total += actual; interest += charge;
  }
  return { periods: null, total: null, interest: null, doesNotAmortize: false };
}

// A savings contribution leaves its source wallet in Casha-Ba. Do not deduct
// that already-held goal balance from accessible wallets for a second time.
export function cashWindow(input: {
  accessible: number; protectedCash: number; bills: number; debts: number;
  essentialDaily: number; days: number; newSaving?: number; purchase?: number;
}) {
  const days = z.number().int().min(0).max(3660).parse(input.days);
  const reserved = cents(input.protectedCash) + cents(input.bills) + cents(input.debts)
    + cents(input.essentialDaily) * days + cents(input.newSaving ?? 0);
  const available = cents(input.accessible) - reserved;
  return { reserved: pesos(reserved), available: pesos(Math.max(0, available)),
    shortfall: pesos(Math.max(0, -available)), afterPurchase: pesos(available - cents(input.purchase ?? 0)),
    dailyLimit: days > 0 ? pesos(Math.floor(Math.max(0, available) / days)) : null };
}
