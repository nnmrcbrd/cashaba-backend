import test from "node:test";
import assert from "node:assert/strict";
import { resolvePeriod } from "@/utils/period";
import { businessDate, businessDateLabel } from './calendar';

test("month and custom ranges use inclusive reporting boundaries", () => {
  const month = resolvePeriod({ period: "month", now: new Date(2026, 8, 15, 12) });
  assert.equal(businessDateLabel(month.start), '2026-09-01');
  assert.equal(businessDateLabel(month.end), '2026-09-30');
  const custom = resolvePeriod({ period: "custom", startDate: "2026-08-02", endDate: "2026-08-04" });
  assert.equal(businessDateLabel(custom.start), '2026-08-02');
  assert.equal(businessDate(custom.end).getUTCHours(), 23);
});
