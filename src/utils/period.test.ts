import test from "node:test";
import assert from "node:assert/strict";
import { resolvePeriod } from "@/utils/period";

test("month and custom ranges use inclusive reporting boundaries", () => {
  const month = resolvePeriod({ period: "month", now: new Date(2026, 8, 15, 12) });
  assert.equal(month.start.getDate(), 1);
  assert.equal(month.end.getMonth(), 8);
  assert.equal(month.end.getDate(), 30);
  const custom = resolvePeriod({ period: "custom", startDate: "2026-08-02", endDate: "2026-08-04" });
  assert.equal(custom.start.getDate(), 2);
  assert.equal(custom.end.getHours(), 23);
});
