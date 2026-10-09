import { z } from 'zod';
import { positiveMoney } from '@/schema/movement';
import { money, roundMoney } from './money';

const scheduleSchema = z.array(z.object({
  start: z.number().int().nonnegative(),
  amount: positiveMoney,
}));
export type BillAmountSchedule = z.infer<typeof scheduleSchema>;

export function billAmountSchedule(value: unknown, fallback: number): BillAmountSchedule {
  const rows = scheduleSchema.parse(value ?? []);
  if (!rows.length) return [{ start: 0, amount: fallback }];
  if (rows[0].start !== 0 || rows.some((row, index) => index > 0 && row.start <= rows[index - 1].start)) {
    throw new Error('Invalid bill amount schedule');
  }
  return rows;
}

// Work in centavos and skip entire fixed-price ranges instead of iterating
// through every old installment. Reversal still uses each period's own amount.
export function billProgress(totalPaid: number, schedule: BillAmountSchedule) {
  let remaining = Math.round(totalPaid * 100);
  for (let index = 0; index < schedule.length; index++) {
    const row = schedule[index];
    const amount = Math.round(row.amount * 100);
    const count = (schedule[index + 1]?.start ?? Infinity) - row.start;
    if (remaining < count * amount) {
      const completed = Math.floor(remaining / amount);
      return { installments: row.start + completed, amountPaid: (remaining - completed * amount) / 100, amount: row.amount };
    }
    remaining -= count * amount;
  }
  throw new Error('Invalid bill payment total');
}

export function replaceBillAmount(schedule: BillAmountSchedule, installment: number, amount: number): BillAmountSchedule {
  return [...schedule.filter(row => row.start < installment), { start: installment, amount }];
}

export function billScheduledTotal(schedule: BillAmountSchedule, start: number, count: number) {
  let total = 0;
  for (let index = 0; index < schedule.length; index++) {
    const row = schedule[index];
    const from = Math.max(start, row.start);
    const to = Math.min(start + count, schedule[index + 1]?.start ?? Infinity);
    total += Math.max(0, to - from) * Math.round(money(row.amount) * 100);
  }
  return roundMoney(total / 100);
}
