import test from "node:test";
import assert from "node:assert/strict";
import { money, roundMoney } from "@/utils/money";

test("money conversion and rounding are stable at cent precision", () => {
  assert.equal(money("123.45"), 123.45);
  assert.equal(money(null), 0);
  assert.equal(roundMoney(10.005), 10.01);
});
