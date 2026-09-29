import { Request, Response } from "express";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { calculateSafeToSpend, calculateSafeToSpendInTransaction, recalculateSafeToSpend } from "@/utils/safeToSpend";
import { money } from "@/utils/money";
import { consumeUsage, refundUsage, UsageLimitError } from '@/services/subscription';
import { LoanRepaymentError, recordLoanPaymentInTransaction } from "@/services/loanRepayment";
import { FinancialError, type FinancialTx, withFinancialOperation } from '@/services/financialOperation';
import { recordMovement, reverseMovement, updateMovement } from '@/services/movements';

const EXPENSE_CATEGORIES = ["Food & Dining", "Transport", "Utilities", "Housing", "Health", "Entertainment", "Education", "Shopping", "Bills", "Debt Payment", "Others"] as const;
const INCOME_CATEGORIES = ["Salary", "Allowance", "Freelance", "Business", "Gift", "Other Income"] as const;
const INTENTS = ["LOG_TRANSACTION", "TRANSFER", "ADD_SAVINGS", "ADD_DEBT", "COLLECT_LOAN", "PAY_BILL", "CORRECT_CATEGORY", "SUMMARY", "UNDO", "GENERAL", "CLARIFY"] as const;

const commandSchema = z.object({
  intent: z.enum(INTENTS),
  transactionId: z.string().uuid().optional(),
  amount: z.number().positive().nullable().optional(),
  category: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  date: z.string().trim().nullable().optional(),
  transactionType: z.enum(["INCOME", "EXPENSE"]).nullable().optional(),
  goalName: z.string().trim().nullable().optional(),
  personName: z.string().trim().nullable().optional(),
  loanType: z.enum(["BORROWED", "LENT"]).nullable().optional(),
  dueDate: z.string().trim().nullable().optional(),
  walletName: z.string().trim().nullable().optional(),
  destinationWalletName: z.string().trim().nullable().optional(),
  obligationName: z.string().trim().nullable().optional(),
  newCategory: z.string().trim().nullable().optional(),
  reply: z.string().trim().nullable().optional(),
  clarificationQuestion: z.string().trim().nullable().optional(),
});
type FinancialCommand = z.infer<typeof commandSchema>;

function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amount);
}
function parseDate(value?: string | null) {
  if (!value) return null;
  if (/^today$/i.test(value)) return new Date();
  if (/^yesterday$/i.test(value)) return new Date(Date.now() - 86_400_000);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function amountFrom(message: string) {
  const match = message.replace(/,/g, "").match(/(?:₱|php\s*)?(\d+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1]) : null;
}
function categoryFrom(message: string) {
  const rules: Array<[RegExp, string]> = [
    [/lunch|dinner|breakfast|grocer|restaurant|coffee|food|jollibee|mcdo/i, "Food & Dining"],
    [/grab|angkas|joyride|fare|fuel|transport/i, "Transport"],
    [/electric|meralco|water|internet|utilit/i, "Utilities"],
    [/rent|housing/i, "Housing"], [/tuition|school|book|education/i, "Education"],
    [/medicine|doctor|hospital|health/i, "Health"], [/gadget|clothes|shop/i, "Shopping"],
  ];
  return rules.find(([rule]) => rule.test(message))?.[1] ?? null;
}
function statedDate(message: string) {
  if (/\btoday\b/i.test(message)) return "today";
  if (/\byesterday\b/i.test(message)) return "yesterday";
  return message.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null;
}
function localFallback(message: string): FinancialCommand {
  const lower = message.toLowerCase();
  const amount = amountFrom(message);
  const date = statedDate(message);
  if (/safe.?to.?spend|summary|daily brief|how much can i spend/.test(lower)) return { intent: "SUMMARY" };
  if (/^\s*why\??\s*$/.test(lower)) return { intent: "GENERAL", reply: "Tell me which result you want explained—for example, ‘Why is my Safe-to-Spend ₱0?’ or ‘Why are my expenses higher than my income?’ Then I can explain it using your records." };
  if (/^\s*(how|how\?|oh,?\s*how\??)\s*$/.test(lower)) return { intent: "GENERAL", reply: "Tell me what you want to do—for example, record an expense, transfer money, add savings, pay a debt, or understand Safe-to-Spend—and I’ll guide you step by step." };
  if (/undo|remove my last|cancel my last/.test(lower)) return { intent: "UNDO" };
  const transfer = message.match(/(?:move|transfer)\s+(?:₱|php\s*)?[\d,.]+\s+from\s+(?:my\s+)?(.+?)\s+to\s+(?:my\s+)?(.+?)(?:\s+(today|yesterday|\d{4}-\d{2}-\d{2}))?$/i);
  if (/\b(move|transfer)\b/.test(lower)) return { intent: "TRANSFER", amount, walletName: transfer?.[1]?.trim() ?? null, destinationWalletName: transfer?.[2]?.trim() ?? null, date: transfer?.[3] ?? date, description: "Wallet transfer", category: "Transfer" };
  const walletMatch = message.match(/(?:from|using|into|in|via)\s+(?:my\s+)?([a-z0-9 .'-]+?)(?:\s+(?:wallet|account))?(?:\s+(?:today|yesterday|on\s+\d{4}-\d{2}-\d{2})|$)/i);
  if (/\b(saved?|add).+\b(goal|fund|savings)\b|\bto\s+.+fund\b/.test(lower)) {
    const goal = message.match(/(?:to|for)\s+(.+?)(?:\s+(?:from|using)\b|\s+(?:today|yesterday)\b|$)/i)?.[1]?.trim();
    return { intent: "ADD_SAVINGS", amount, goalName: goal ?? null, walletName: walletMatch?.[1]?.trim() ?? null, date };
  }
  if (/\bmark|pay|paid\b/.test(lower) && /\bbill|rent|electric|water|internet|subscription\b/.test(lower)) {
    const obligationName = message.match(/(?:pay|paid|mark)\s+(?:my\s+)?(.+?)(?:\s+(?:bill\s+)?(?:from|using)|\s+(?:today|yesterday)|$)/i)?.[1]?.replace(/\s+bill$/i, "").trim();
    return { intent: "PAY_BILL", amount, obligationName: obligationName ?? null, walletName: walletMatch?.[1]?.trim() ?? null, date };
  }
  if (/\b(collected?|repaid|paid me)\b/.test(lower)) {
    const person = message.match(/\bfrom\s+([a-z][a-z .'-]*?)(?:\s+(?:into|via|today|yesterday)|$)/i)?.[1]?.trim();
    return { intent: "COLLECT_LOAN", amount, personName: person ?? null, walletName: walletMatch?.[1]?.trim() ?? null, date };
  }
  if (/\b(owe|borrowed|lent)\b/.test(lower)) {
    const person = message.match(/(?:to|from)\s+([a-z][a-z .'-]*?)(?:\s+due\b|$)/i)?.[1]?.trim();
    const dueDate = message.match(/\bdue\s+(.+)$/i)?.[1]?.trim() ?? null;
    return { intent: "ADD_DEBT", amount, personName: person ?? null, loanType: /\blent\b/.test(lower) ? "LENT" : "BORROWED", dueDate };
  }
  const correction = message.match(/(?:should be|category to)\s+(?:under\s+)?([a-z &]+)/i);
  if (correction) return { intent: "CORRECT_CATEGORY", newCategory: correction[1].trim() };
  if (/\b(spent|bought|paid|received|salary|allowance|income|earned)\b/.test(lower)) {
    const transactionType = /\b(received|salary|allowance|income|earned)\b/.test(lower) ? "INCOME" : "EXPENSE";
    const incomeCategory = /allowance/.test(lower) ? "Allowance" : /salary/.test(lower) ? "Salary" : /freelance/.test(lower) ? "Freelance" : "Other Income";
    const description = message.replace(/(?:₱|php\s*)?[\d,.]+/i, "").replace(/^\s*(i\s+)?(spent|bought|paid|received|earned)\s*/i, "").replace(/^\s*(on|for)\s*/i, "").trim();
    return { intent: "LOG_TRANSACTION", amount, transactionType, category: transactionType === "INCOME" ? incomeCategory : categoryFrom(message), description: description || null, walletName: walletMatch?.[1]?.trim() ?? null, date };
  }
  return { intent: "GENERAL", reply: "I can record income and expenses, transfer money, fund savings, pay bills, track debts, undo your last entry, or explain your Safe-to-Spend." };
}

async function buildAiContext(userId: string) {
  if (!process.env.GEMINI_API_KEY) return "Financial context is unavailable.";

  const [breakdown, obligations, goals, loans, recentTransactions, recentHistory] = await Promise.all([
    calculateSafeToSpend(userId),
    prisma.fixedExpense.findMany({
      where: { userId, status: { in: ["PENDING", "PARTIALLY_PAID", "OVERDUE"] } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: 8,
      select: { name: true, amount: true, amountPaid: true, dueDate: true, frequency: true, status: true },
    }),
    prisma.savingsGoal.findMany({
      where: { userId, isCompleted: false },
      orderBy: { createdAt: "asc" },
      take: 6,
      select: { name: true, targetAmount: true, currentAmount: true, monthlyAllocation: true },
    }),
    prisma.loan.findMany({
      where: { userId, status: { in: ["ACTIVE", "OVERDUE"] } },
      orderBy: { deadline: "asc" },
      take: 6,
      select: { title: true, type: true, amount: true, amountPaid: true, deadline: true, status: true },
    }),
    prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      orderBy: { date: "desc" },
      take: 12,
      select: { description: true, type: true, category: true, amount: true, date: true },
    }),
    prisma.aiSession.findMany({
      where: { userId, state: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      take: 4,
      select: { question: true, answer: true },
    }),
  ]);

  return JSON.stringify({
    period: { start: breakdown.periodStart.slice(0, 10), end: breakdown.periodEnd.slice(0, 10) },
    totals: {
      income: breakdown.totalIncome,
      obligationsReserved: breakdown.totalFixed,
      savingsAllocated: breakdown.totalSavings,
      debtPaymentsDue: breakdown.totalLoanRepayments,
      spendingRecorded: breakdown.totalExpenses,
      safeToSpend: breakdown.safeToSpend,
      shortfall: Math.max(0, -breakdown.rawSafeToSpend),
    },
    obligations: obligations.map((item) => ({
      name: item.name,
      remaining: Math.max(0, money(item.amount) - money(item.amountPaid)),
      dueDate: item.dueDate?.toISOString().slice(0, 10) || null,
      frequency: item.frequency,
      status: item.status,
    })),
    savingsGoals: goals.map((goal) => ({
      name: goal.name,
      saved: money(goal.currentAmount),
      target: money(goal.targetAmount),
      plannedAllocation: money(goal.monthlyAllocation),
    })),
    loans: loans.map((loan) => ({
      title: loan.title,
      type: loan.type,
      remaining: Math.max(0, money(loan.amount) - money(loan.amountPaid)),
      deadline: loan.deadline.toISOString().slice(0, 10),
      status: loan.status,
    })),
    recentTransactions: recentTransactions.map((transaction) => ({
      description: transaction.description,
      type: transaction.type,
      category: transaction.category,
      amount: money(transaction.amount),
      date: transaction.date.toISOString().slice(0, 10),
    })),
    recentConversation: recentHistory.reverse(),
  });
}

async function parseCommand(message: string, financialContext: string) {
  if (!process.env.GEMINI_API_KEY) return { command: localFallback(message), model: "local-fallback", usage: { prompt: 0, response: 0, total: 0 } };
  try {
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model,
      contents: message,
      config: {
        systemInstruction: `You are Casha-Ba, a careful personal-finance assistant for Filipino users. Return one JSON command using these intents: ${INTENTS.join(", ")}.

For record-changing requests, extract only facts explicitly stated by the user. Never invent an amount, wallet, date, category, goal, person, obligation, destination, or due date. Transactions, savings, transfers, collections, and bill payments require an explicit wallet and date. Use CLARIFY with one focused clarificationQuestion when required information is missing. Income categories: ${INCOME_CATEGORIES.join(", ")}. Expense categories: ${EXPENSE_CATEGORIES.join(", ")}.

Use SUMMARY for requests for a financial brief, totals, or Safe-to-Spend. Use GENERAL for explanations, comparisons, coaching, or questions that do not change records. For GENERAL, put the complete answer in reply. Base it only on the verified financial context below; never invent figures or imply that records were changed. Say when data is unavailable. Use Philippine pesos, short paragraphs or hyphen bullets, concrete next steps, and normally no more than 180 words. Prioritize overdue items, shortfalls, and near-term risks over generic encouragement.

Verified financial context:
${financialContext}`,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        maxOutputTokens: 1024,
      },
    });
    return { command: commandSchema.parse(JSON.parse(response.text || "{}")), model, usage: { prompt: response.usageMetadata?.promptTokenCount ?? 0, response: response.usageMetadata?.candidatesTokenCount ?? 0, total: response.usageMetadata?.totalTokenCount ?? 0 } };
  } catch (error) {
    console.warn("Gemini command extraction failed; using local parser", error);
    return { command: localFallback(message), model: "local-fallback", usage: { prompt: 0, response: 0, total: 0 } };
  }
}

function missingDetail(command: FinancialCommand): string | null {
  if (["LOG_TRANSACTION", "TRANSFER", "ADD_SAVINGS", "COLLECT_LOAN", "PAY_BILL"].includes(command.intent)) {
    if (!command.amount) return "What is the amount?";
    if (!command.walletName) return "Which wallet or account should I use?";
    if (!command.date) return "What date should I record? You can say today or provide YYYY-MM-DD.";
  }
  if (command.intent === "LOG_TRANSACTION") {
    if (!command.transactionType) return "Is this income or an expense?";
    if (!command.description) return "What is this transaction for?";
    if (!command.category) return "Which category should I use?";
  }
  if (command.intent === "TRANSFER" && !command.destinationWalletName) return "Which destination wallet should receive the transfer?";
  if (command.intent === "ADD_SAVINGS" && !command.goalName) return "Which savings goal should receive the contribution?";
  if (command.intent === "ADD_DEBT") {
    if (!command.amount) return "What is the debt amount?";
    if (!command.personName) return "Who is the creditor or borrower?";
    if (!command.loanType) return "Did you borrow or lend this money?";
    if (!command.dueDate) return "What is the due date?";
  }
  if (command.intent === "COLLECT_LOAN" && !command.personName) return "Who repaid the loan?";
  if (command.intent === "PAY_BILL" && !command.obligationName) return "Which bill or obligation are you paying?";
  if (command.intent === "CORRECT_CATEGORY" && !command.newCategory) return "Which category should I use?";
  return null;
}

function preview(command: FinancialCommand) {
  if (command.intent === "LOG_TRANSACTION") return `${command.transactionType === "INCOME" ? "Income" : "Expense"}: ${formatMoney(command.amount!)} · ${command.category} · ${command.walletName} · ${command.date}`;
  if (command.intent === "TRANSFER") return `Transfer: ${formatMoney(command.amount!)} · ${command.walletName} → ${command.destinationWalletName} · ${command.date}`;
  if (command.intent === "ADD_SAVINGS") return `Savings contribution: ${formatMoney(command.amount!)} · ${command.goalName} · from ${command.walletName} · ${command.date}`;
  if (command.intent === "ADD_DEBT") return `${command.loanType === "LENT" ? "Lent" : "Borrowed"}: ${formatMoney(command.amount!)} · ${command.personName} · due ${command.dueDate}`;
  if (command.intent === "COLLECT_LOAN") return `Loan collection: ${formatMoney(command.amount!)} · from ${command.personName} · into ${command.walletName} · ${command.date}`;
  if (command.intent === "PAY_BILL") return `Bill payment: ${formatMoney(command.amount!)} · ${command.obligationName} · from ${command.walletName} · ${command.date}`;
  if (command.intent === "CORRECT_CATEGORY") return `Change the latest expense category to ${command.newCategory}`;
  if (command.intent === "UNDO") return "Undo the most recent transaction";
  return "Apply this financial action";
}

async function findWallet(tx: FinancialTx, userId: string, name: string) {
  const wallets = await tx.wallet.findMany({ where: { userId, name: { contains: name, mode: 'insensitive' } }, take: 2 });
  if (wallets.length !== 1) throw new Error(wallets.length ? 'WALLET_AMBIGUOUS' : 'WALLET_NOT_FOUND');
  return wallets[0];
}
async function executeCommand(tx: FinancialTx, userId: string, command: FinancialCommand) {
  if (command.intent === 'UNDO' || command.intent === 'CORRECT_CATEGORY') {
    if (!command.transactionId) throw new FinancialError('This preview expired. Request the action again.', 409);
    if (command.intent === 'UNDO') { await reverseMovement(tx, userId, command.transactionId); return 'Reversed the selected transaction.'; }
    await updateMovement(tx, userId, command.transactionId, { category: command.newCategory! });
    return 'Updated the selected transaction category.';
  }
  if (command.intent === 'ADD_DEBT') {
    const deadline = parseDate(command.dueDate);
    if (!deadline) throw new Error('INVALID_DATE');
    await tx.loan.create({ data: { userId, title: (command.loanType === 'BORROWED' ? 'Owe ' : 'Lent to ') + command.personName, amount: command.amount!, type: command.loanType!, status: deadline < new Date() ? 'OVERDUE' : 'ACTIVE', startDate: new Date(), deadline, scheduleAnchor: deadline, repaymentAmount: command.amount!, repaymentFrequency: 'ONE_TIME' } });
    return 'Recorded debt of ' + formatMoney(command.amount!) + '.';
  }
  const wallet = await findWallet(tx, userId, command.walletName!);
  const date = parseDate(command.date);
  if (!date) throw new Error('INVALID_DATE');
  if (command.intent === 'COLLECT_LOAN') {
    const loans = await tx.loan.findMany({ where: { userId, type: 'LENT', status: { in: ['ACTIVE', 'OVERDUE'] }, title: { contains: command.personName!, mode: 'insensitive' } }, take: 2 });
    if (loans.length !== 1) throw new Error(loans.length ? 'LOAN_AMBIGUOUS' : 'LOAN_NOT_FOUND');
    await recordLoanPaymentInTransaction(tx, { userId, loanId: loans[0].id, amount: command.amount!, paidAt: date, walletId: wallet.id });
    return 'Recorded loan collection of ' + formatMoney(command.amount!) + '.';
  }
  let savingsGoalId: string | undefined, fixedExpenseId: string | undefined, destinationWalletId: string | undefined;
  if (command.intent === 'TRANSFER') destinationWalletId = (await findWallet(tx, userId, command.destinationWalletName!)).id;
  if (command.intent === 'ADD_SAVINGS') {
    const goals = await tx.savingsGoal.findMany({ where: { userId, name: { contains: command.goalName!, mode: 'insensitive' } }, take: 2 });
    if (goals.length !== 1) throw new Error(goals.length ? 'GOAL_AMBIGUOUS' : 'GOAL_NOT_FOUND');
    savingsGoalId = goals[0].id;
  }
  if (command.intent === 'PAY_BILL') {
    const bills = await tx.fixedExpense.findMany({ where: { userId, name: { contains: command.obligationName!, mode: 'insensitive' }, status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] } }, take: 2 });
    if (bills.length !== 1) throw new Error(bills.length ? 'BILL_AMBIGUOUS' : 'BILL_NOT_FOUND');
    fixedExpenseId = bills[0].id;
  }
  const type = command.intent === 'TRANSFER' ? 'TRANSFER' : command.intent === 'ADD_SAVINGS' ? 'SAVINGS_CONTRIBUTION' : command.intent === 'PAY_BILL' ? 'BILL_PAYMENT' : command.transactionType;
  await recordMovement(tx, userId, { walletId: wallet.id, destinationWalletId, savingsGoalId, fixedExpenseId, type, amount: command.amount, date, description: command.description || command.goalName || command.obligationName || 'Wallet transfer', category: command.category || (savingsGoalId ? 'Savings' : fixedExpenseId ? 'Bills' : 'Transfer') });
  return 'Recorded ' + formatMoney(command.amount!) + ' in ' + wallet.name + '.';
}

export async function confirmAiAction(userId: string, confirmationId: string) {
  return withFinancialOperation(userId, async tx => {
    const pending = await tx.aiSession.findFirst({ where: { id: confirmationId, userId } });
    if (!pending || pending.state !== 'AWAITING_CONFIRMATION') throw new FinancialError('This action is no longer awaiting confirmation', 409);
    const command = commandSchema.parse(pending.pendingAction);
    const missing = missingDetail(command);
    if (missing) throw new FinancialError(missing);
    const reply = await executeCommand(tx, userId, command);
    const { safeToSpend } = await calculateSafeToSpendInTransaction(tx, userId);
    const content = reply + ' Safe-to-Spend: ' + formatMoney(safeToSpend) + '.';
    await tx.aiSession.update({ where: { id: pending.id }, data: { state: 'COMPLETED', answer: content } });
    return { id: pending.id, role: 'assistant', content, timestamp: new Date().toISOString(), safeToSpend };
  }, { key: 'ai:' + confirmationId, payload: { confirmationId } });
}

async function saveTurn(userId: string, question: string, answer: string, model: string, usage: { prompt: number; response: number; total: number }, state: "COMPLETED" | "NEEDS_CLARIFICATION" | "AWAITING_CONFIRMATION" | "CANCELLED" = "COMPLETED", pendingAction?: FinancialCommand | null) {
  return prisma.aiSession.create({ data: { userId, question, answer, model, promptTokens: usage.prompt, responseTokens: usage.response, totalTokens: usage.total, state, pendingAction: pendingAction ? JSON.parse(JSON.stringify(pendingAction)) : undefined } });
}

export const processAiChat = async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  let chargedUsagePeriodId: string | null = null;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 1000) return res.status(400).json({ message: "Message must contain between 1 and 1000 characters" });
  try {
    const confirmationId = typeof req.body.confirmationId === 'string' ? req.body.confirmationId : null;
    if (/^(confirm|yes|save|do it)$/i.test(message)) {
      if (!confirmationId) throw new FinancialError('Select the action to confirm or request a new preview', 409);
      return res.json(await confirmAiAction(userId, confirmationId));
    }
    if (confirmationId && /^(cancel|no|never mind)$/i.test(message)) {
      await withFinancialOperation(userId, async tx => {
        const result = await tx.aiSession.updateMany({ where: { id: confirmationId, userId, state: 'AWAITING_CONFIRMATION' }, data: { state: 'CANCELLED' } });
        if (!result.count) throw new FinancialError('This action is no longer awaiting confirmation', 409);
        return { cancelled: true };
      });
      return res.json({ id: confirmationId, role: 'assistant', content: 'Cancelled.', timestamp: new Date() });
    }
    const pending = await prisma.aiSession.findFirst({ where: { userId, state: { in: ['NEEDS_CLARIFICATION', 'AWAITING_CONFIRMATION'] } }, orderBy: { createdAt: 'desc' } });
    if (pending?.state === 'AWAITING_CONFIRMATION') return res.json({ id: pending.id, role: 'assistant', content: pending.answer, timestamp: pending.createdAt, requiresConfirmation: true });

    const effectiveMessage = pending?.state === "NEEDS_CLARIFICATION" ? `${pending.question}. Additional detail: ${message}` : message;
    if (pending) await prisma.aiSession.update({ where: { id: pending.id }, data: { state: "COMPLETED" } });
    chargedUsagePeriodId = (await consumeUsage(userId, 'aiRequests')).id;
    const financialContext = await buildAiContext(userId);
    const parsed = await parseCommand(effectiveMessage, financialContext);
    const command = parsed.command;
    const missing = command.intent === "CLARIFY" ? command.clarificationQuestion || "What detail should I use?" : missingDetail(command);
    if (missing) {
      const session = await saveTurn(userId, effectiveMessage, missing, parsed.model, parsed.usage, "NEEDS_CLARIFICATION", command);
      return res.json({ id: session.id, role: "assistant", content: missing, timestamp: session.createdAt, requiresClarification: true, model: parsed.model });
    }
    if (["SUMMARY", "GENERAL"].includes(command.intent)) {
      const safeToSpend = await recalculateSafeToSpend(userId);
      const breakdown = await calculateSafeToSpend(userId);
      const reply = command.intent === "SUMMARY"
        ? [
            `Here is your ${breakdown.periodStart && breakdown.periodEnd ? "current-period" : "latest"} financial brief:`,
            `• Income used: ${formatMoney(breakdown.totalIncome)}`,
            `• Bills still reserved: ${formatMoney(breakdown.totalFixed)}`,
            `• Savings allocations: ${formatMoney(breakdown.totalSavings)}`,
            `• Debt payments due: ${formatMoney(breakdown.totalLoanRepayments)}`,
            `• Spending recorded: ${formatMoney(breakdown.totalExpenses)}`,
            `• Safe-to-Spend: ${formatMoney(safeToSpend)}`,
          ].join("\n")
        : command.reply || "How can I help?";
      const session = await saveTurn(userId, message, reply, parsed.model, parsed.usage);
      return res.json({ id: session.id, role: "assistant", content: reply, timestamp: session.createdAt, safeToSpend, model: parsed.model });
    }
    if (command.intent === 'UNDO' || command.intent === 'CORRECT_CATEGORY') {
      const target = await prisma.transaction.findFirst({ where: { userId, deletedAt: null, ...(command.intent === 'CORRECT_CATEGORY' ? { type: 'EXPENSE' as const } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if (!target) throw new FinancialError('No transaction is available for that action', 404);
      command.transactionId = target.id;
    }
    const confirmation = `${preview(command)}\nReply “confirm” to save it or “cancel” to discard it.`;
    const session = await saveTurn(userId, effectiveMessage, confirmation, parsed.model, parsed.usage, "AWAITING_CONFIRMATION", command);
    res.json({ id: session.id, role: "assistant", content: confirmation, timestamp: session.createdAt, requiresConfirmation: true, model: parsed.model });
  } catch (error) {
    if (chargedUsagePeriodId) {
      try {
        await refundUsage(userId, 'aiRequests', chargedUsagePeriodId);
      } catch (refundError) {
        console.error('AI quota refund failed', refundError);
      }
    }
    console.error("AI command processing error", error);
    const code = error instanceof Error ? error.message : "";
    const messages: Record<string, string> = {
      WALLET_NOT_FOUND: "I couldn't find that wallet.", WALLET_AMBIGUOUS: "More than one wallet matches that name.", SAME_WALLET: "Source and destination wallets must differ.",
      GOAL_NOT_FOUND: "I couldn't find that savings goal.", GOAL_AMBIGUOUS: "More than one savings goal matches that name.",
      LOAN_NOT_FOUND: "I couldn't find that active loan.", LOAN_AMBIGUOUS: "More than one loan matches that person.",
      BILL_NOT_FOUND: "I couldn't find that unpaid obligation.", BILL_AMBIGUOUS: "More than one obligation matches that name.", PAYMENT_EXCEEDS_REMAINING: "The payment exceeds the remaining amount.", INVALID_DATE: "That date is invalid.",
    };
    if (error instanceof LoanRepaymentError) return res.status(error.status).json({ message: error.message });
    if (error instanceof UsageLimitError) return res.status(error.status).json({ message: error.message, code: 'USAGE_LIMIT_REACHED', metric: error.metric, limit: error.limit });
    res.status(messages[code] ? 400 : 500).json({ message: messages[code] || "Error processing AI chat" });
  }
};

export const getAiHistory = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const history = await prisma.aiSession.findMany({ where: { userId: req.user!.userId, question: { not: { startsWith: '__DASHBOARD_INSIGHTS__:' } } }, orderBy: { createdAt: "desc" }, take: limit });
    res.json(history.reverse());
  } catch {
    res.status(500).json({ message: "Error fetching AI history" });
  }
};
