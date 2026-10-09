import test from 'node:test';
import assert from 'node:assert/strict';
import { billAmountSchedule, billProgress, billScheduledTotal, replaceBillAmount } from './billAmounts';

test('a higher next bill retains the old paid installment', () => {
  const schedule = replaceBillAmount(billAmountSchedule([], 150), 1, 250);
  assert.deepEqual(billProgress(150, schedule), { installments: 1, amountPaid: 0, amount: 250 });
  assert.deepEqual(billProgress(400, schedule), { installments: 2, amountPaid: 0, amount: 250 });
});
test('a lower bill preserves partial payments and exact centavos', () => {
  const schedule = replaceBillAmount(billAmountSchedule([], 200.25), 0, 150.75);
  assert.deepEqual(billProgress(50.25, schedule), { installments: 0, amountPaid: 50.25, amount: 150.75 });
  assert.deepEqual(billProgress(150.75, schedule), { installments: 1, amountPaid: 0, amount: 150.75 });
});
test('reversing an old payment reopens its original priced period', () => {
  const schedule = [{ start: 0, amount: 150 }, { start: 1, amount: 250 }, { start: 2, amount: 100 }];
  assert.deepEqual(billProgress(140, schedule), { installments: 0, amountPaid: 140, amount: 150 });
  assert.equal(billScheduledTotal(schedule, 0, 3), 500);
  assert.equal(billScheduledTotal(schedule, 1, 3), 450);
});
test('many installments are calculated without one iteration per bill', () => {
  assert.deepEqual(billProgress(100_000_050, [{ start: 0, amount: 100 }]), { installments: 1_000_000, amountPaid: 50, amount: 100 });
});
test('invalid persisted schedules fail instead of inventing history', () => {
  assert.throws(() => billAmountSchedule([{ start: 1, amount: 100 }], 100));
  assert.throws(() => billAmountSchedule([{ start: 0, amount: 100 }, { start: 0, amount: 200 }], 100));
  assert.throws(() => billAmountSchedule([{ start: 0, amount: 0 }], 100));
});
