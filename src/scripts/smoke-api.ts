import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.js";

const baseUrl = process.env.SMOKE_API_URL || "http://localhost:8011/api";
const email = `casha-smoke-${Date.now()}@example.test`;
const password = "SmokePass123";
let token = "";

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload as Record<string, any>;
}

try {
  const health = await request("/health");
  assert.equal(health.database, "connected");
  await request("/auth/signup", { method: "POST", body: JSON.stringify({ firstName: "Smoke", lastName: "Audit", email, password, gender: "Female" }) });
  const login = await request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  token = login.accessToken;
  assert.ok(token);

  await request("/users/me", { method: "PATCH", body: JSON.stringify({ firstName: "Smoke", lastName: "Audit", roles: ["WORKING"], customRole: null, region: null }) });
  const cash = await request("/wallets", { method: "POST", body: JSON.stringify({ name: "Cash", accountType: "CASH", kind: "ASSET", openingBalance: 10000, icon: "wallet", color: "#0f766e" }) });
  const ewallet = await request("/wallets", { method: "POST", body: JSON.stringify({ name: "Test E-wallet", accountType: "EWALLET", kind: "ASSET", openingBalance: 1000, icon: "phone", color: "#0284c7" }) });
  await request("/income-setup", { method: "POST", body: JSON.stringify({ totalIncome: 25000, incomePeriod: "monthly" }) });

  const dueDate = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const obligation = await request("/income-setup/fixed-expenses", { method: "POST", body: JSON.stringify({ name: "Smoke Utility", amount: 1000, dueDate, frequency: "MONTHLY", category: "Utilities", reminderDays: 3 }) });
  const goal = await request("/income-setup/savings-goals", { method: "POST", body: JSON.stringify({ name: "Smoke Emergency Fund", targetAmount: 5000, monthlyAllocation: 500 }) });
  const now = new Date();
  await request("/budget", { method: "PUT", body: JSON.stringify({ targetAmount: 10000, month: now.getMonth() + 1, year: now.getFullYear(), categories: [{ category: "Food & Dining", limitAmount: 2000 }] }) });

  const today = now.toISOString();
  const rejected = await fetch(`${baseUrl}/transactions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ description: "Missing wallet", type: "EXPENSE", category: "Others", amount: 1, date: today }) });
  assert.equal(rejected.status, 400, "new ledger entries must require an account");
  await request("/transactions", { method: "POST", body: JSON.stringify({ description: "Smoke lunch", type: "EXPENSE", category: "Food & Dining", amount: 150, date: today, walletId: cash.id }) });
  await request("/transactions", { method: "POST", body: JSON.stringify({ description: "Smoke transfer", type: "TRANSFER", category: "Transfer", amount: 500, date: today, walletId: cash.id, destinationWalletId: ewallet.id }) });
  await request(`/income-setup/savings-goals/${goal.goal.id}`, { method: "PATCH", body: JSON.stringify({ addAmount: 300, walletId: cash.id }) });

  const loan = await request("/loans", { method: "POST", body: JSON.stringify({ title: "Smoke debt", amount: 2000, type: "BORROWED", deadline: today, repaymentAmount: 500, repaymentFrequency: "MONTHLY" }) });
  const originalDeadline = loan.deadline;
  await request(`/loans/${loan.id}/repayments`, { method: "POST", body: JSON.stringify({ amount: 200, date: today, walletId: cash.id }) });
  const loanState = await request("/loans");
  const updatedLoan = loanState.loans.find((item: { id: string }) => item.id === loan.id);
  assert.equal(updatedLoan.installmentPaid, 200);
  assert.equal(updatedLoan.deadline, originalDeadline, "partial repayment must not advance the due date");

  await request("/transactions", { method: "POST", body: JSON.stringify({ description: "Smoke utility payment", type: "BILL_PAYMENT", category: "Utilities", amount: 400, date: today, walletId: cash.id, fixedExpenseId: obligation.expense.id }) });
  const wallets = await request("/wallets");
  assert.equal(wallets.find((item: { id: string }) => item.id === cash.id).balance, 8450);
  assert.equal(wallets.find((item: { id: string }) => item.id === ewallet.id).balance, 1500);

  const analytics = await request("/analytics?period=month");
  assert.equal(analytics.summary.totalExpenses, 750);
  assert.equal(analytics.budget.spent, 750);
  const setup = await request("/income-setup");
  assert.equal(setup.breakdown.totalLoanRepayments, 300);
  assert.equal(setup.breakdown.totalFixed, 600);

  await request("/users/me/onboarding", { method: "PATCH", body: JSON.stringify({ step: 5, complete: true }) });
  const profile = await request("/users/me");
  assert.equal(profile.onboardingComplete, true);
  const exportData = await request("/users/me/export");
  assert.equal(exportData.user.email, email);
  assert.equal("password" in exportData.user, false);
  await request("/notifications");
  await request("/user/health-score");

  await request("/transactions/undo", { method: "POST", body: "{}" });
  const afterUndo = await request("/wallets");
  assert.equal(afterUndo.find((item: { id: string }) => item.id === cash.id).balance, 8850);

  await request("/users/me", { method: "DELETE", body: JSON.stringify({ password }) });
  token = "";
  console.log(JSON.stringify({ status: "passed", checks: 20, cleanup: "account deleted" }));
} finally {
  await prisma.user.deleteMany({ where: { email } });
  await prisma.$disconnect();
}
