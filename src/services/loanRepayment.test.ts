import test from "node:test";
import assert from "node:assert/strict";
import { calculateRepaymentProgress } from "@/services/loanRepayment";

test("partial repayment does not advance a recurring deadline", () => {
  const deadline = new Date("2026-09-15T00:00:00Z");
  const result = calculateRepaymentProgress({ deadline, frequency: "MONTHLY", repaymentAmount: 1000, installmentPaid: 0, payment: 400, isPaidOff: false });
  assert.equal(result.installmentPaid, 400);
  assert.equal(result.deadline.toISOString(), deadline.toISOString());
});

test("completed installment advances deadline and carries over extra payment", () => {
  const result = calculateRepaymentProgress({ deadline: new Date("2026-09-15T00:00:00Z"), frequency: "MONTHLY", repaymentAmount: 1000, installmentPaid: 400, payment: 800, isPaidOff: false });
  assert.equal(result.installmentPaid, 200);
  assert.equal(result.deadline.toISOString(), "2026-10-15T00:00:00.000Z");
});
