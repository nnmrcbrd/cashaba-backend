import test from "node:test";
import assert from "node:assert/strict";
import { calculateWalletBalance } from "@/controllers/wallet.controller";

test("asset account applies income, spending, transfers and savings correctly", () => {
  assert.equal(calculateWalletBalance({ openingBalance: 1000, kind: "ASSET", transactions: [
    { type: "INCOME", amount: 500, category: "Salary" },
    { type: "EXPENSE", amount: 100, category: "Food" },
    { type: "TRANSFER", amount: 200, category: "Transfer" },
    { type: "SAVINGS_CONTRIBUTION", amount: 50, category: "Savings" },
  ], incomingTransfers: [{ amount: 300 }] }), 1450);
});

test("liability account increases for charges and decreases for payments or incoming transfers", () => {
  assert.equal(calculateWalletBalance({ openingBalance: 1000, kind: "LIABILITY", transactions: [
    { type: "EXPENSE", amount: 200, category: "Food" },
    { type: "BILL_PAYMENT", amount: 100, category: "Bills" },
    { type: "INCOME", amount: 150, category: "Payment" },
  ], incomingTransfers: [{ amount: 250 }] }), 900);
});
