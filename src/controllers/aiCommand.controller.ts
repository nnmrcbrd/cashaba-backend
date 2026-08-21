import { Request, Response } from "express";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { recalculateSafeToSpend } from "@/utils/safeToSpend";

const EXPENSE_CATEGORIES = [
  "Food & Dining",
  "Transport",
  "Utilities",
  "Housing",
  "Health",
  "Entertainment",
  "Education",
  "Shopping",
  "Savings",
  "Debt Payment",
  "Others",
] as const;

const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, "Income"] as const;
const INTENTS = [
  "LOG_TRANSACTION",
  "CORRECT_CATEGORY",
  "ADD_SAVINGS",
  "ADD_DEBT",
  "SUMMARY",
  "GENERAL",
  "CLARIFY",
] as const;

const commandSchema = z.object({
  intent: z.enum(INTENTS),
  amount: z.number().positive().nullable().optional(),
  category: z.enum(ALL_CATEGORIES).nullable().optional(),
  description: z.string().trim().min(1).nullable().optional(),
  date: z.string().trim().min(1).nullable().optional(),
  transactionType: z.enum(["INCOME", "EXPENSE"]).nullable().optional(),
  goalName: z.string().trim().min(1).nullable().optional(),
  creditorName: z.string().trim().min(1).nullable().optional(),
  loanType: z.enum(["BORROWED", "LENT"]).nullable().optional(),
  dueDate: z.string().trim().min(1).nullable().optional(),
  newCategory: z.enum(EXPENSE_CATEGORIES).nullable().optional(),
  reply: z.string().trim().min(1).nullable().optional(),
  clarificationQuestion: z.string().trim().min(1).nullable().optional(),
});

type FinancialCommand = z.infer<typeof commandSchema>;

const responseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent"],
  properties: {
    intent: { type: "string", enum: INTENTS },
    amount: { type: ["number", "null"], minimum: 0.01 },
    category: { type: ["string", "null"], enum: [...ALL_CATEGORIES, null] },
    description: { type: ["string", "null"] },
    date: { type: ["string", "null"], format: "date" },
    transactionType: { type: ["string", "null"], enum: ["INCOME", "EXPENSE", null] },
    goalName: { type: ["string", "null"] },
    creditorName: { type: ["string", "null"] },
    loanType: { type: ["string", "null"], enum: ["BORROWED", "LENT", null] },
    dueDate: { type: ["string", "null"], format: "date" },
    newCategory: { type: ["string", "null"], enum: [...EXPENSE_CATEGORIES, null] },
    reply: { type: ["string", "null"] },
    clarificationQuestion: { type: ["string", "null"] },
  },
};

function formatMoney(amount: number): string {
  return `₱${amount.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseDate(value?: string | null, defaultToToday = false): Date | null {
  if (!value) return defaultToToday ? new Date() : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferCategory(message: string): typeof EXPENSE_CATEGORIES[number] | null {
  const rules: Array<[RegExp, typeof EXPENSE_CATEGORIES[number]]> = [
    [/grocer|restaurant|coffee|snack|meal|food|jollibee|mcdo/i, "Food & Dining"],
    [/grab|angkas|joyride|fare|fuel|gas|parking|transport/i, "Transport"],
    [/meralco|electric|water|internet|phone bill|utilit/i, "Utilities"],
    [/rent|condo|repair|housing/i, "Housing"],
    [/medicine|doctor|clinic|hospital|gym|health/i, "Health"],
    [/movie|game|netflix|spotify|entertainment/i, "Entertainment"],
    [/tuition|book|course|school|education/i, "Education"],
    [/clothes|clothing|gadget|personal care|shop/i, "Shopping"],
  ];
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

function localFallback(message: string): FinancialCommand {
  const lower = message.toLowerCase();
  if (/summary|safe[ -]?to[ -]?spend|daily brief|how much can i spend/.test(lower)) {
    return { intent: "SUMMARY" };
  }

  const correction = message.match(/(?:should be|category to)\s+(?:under\s+)?([a-z &]+)/i);
  if (correction) {
    const requested = EXPENSE_CATEGORIES.find(
      (category) => category.toLowerCase() === correction[1].trim().toLowerCase(),
    );
    return requested
      ? { intent: "CORRECT_CATEGORY", newCategory: requested }
      : { intent: "CLARIFY", clarificationQuestion: `Which approved category should I use: ${EXPENSE_CATEGORIES.join(", ")}?` };
  }

  const amountMatch = message.match(/(?:₱|php\s*)?(\d+(?:\.\d{1,2})?)/i);
  const amount = amountMatch ? Number(amountMatch[1]) : null;

  if (/\b(save|savings|fund|goal)\b/.test(lower)) {
    const goalMatch = message.match(/(?:to|for)\s+(.+)$/i);
    if (!amount) return { intent: "CLARIFY", clarificationQuestion: "How much would you like to add to the savings goal?" };
    if (!goalMatch) return { intent: "CLARIFY", clarificationQuestion: "Which existing savings goal should receive this amount?" };
    return { intent: "ADD_SAVINGS", amount, goalName: goalMatch[1].trim() };
  }

  if (/\b(owe|borrowed|lent)\b/.test(lower)) {
    const personMatch = message.match(/(?:to|from)\s+([a-z][a-z .'-]*?)(?:\s+due\b|$)/i);
    const dueMatch = message.match(/\bdue\s+(.+)$/i);
    if (!amount) return { intent: "CLARIFY", clarificationQuestion: "What is the debt amount?" };
    if (!personMatch) return { intent: "CLARIFY", clarificationQuestion: "Who is the creditor or borrower?" };
    if (!dueMatch) return { intent: "CLARIFY", clarificationQuestion: "What is the debt due date?" };
    return {
      intent: "ADD_DEBT",
      amount,
      creditorName: personMatch[1].trim(),
      loanType: /\blent\b/.test(lower) ? "LENT" : "BORROWED",
      dueDate: dueMatch[1].trim(),
    };
  }

  if (/\b(spent|bought|paid|received|salary|income)\b/.test(lower)) {
    if (!amount) return { intent: "CLARIFY", clarificationQuestion: "What was the transaction amount?" };
    const transactionType = /\b(received|salary|income)\b/.test(lower) ? "INCOME" : "EXPENSE";
    const description = message
      .replace(/(?:₱|php\s*)?\d+(?:\.\d{1,2})?/i, "")
      .replace(/^\s*(spent|bought|paid|received)\s*/i, "")
      .replace(/^\s*(on|for)\s*/i, "")
      .trim();
    if (!description) return { intent: "CLARIFY", clarificationQuestion: "What was this transaction for?" };
    const category = transactionType === "INCOME" ? "Income" : inferCategory(message);
    if (!category) return { intent: "CLARIFY", clarificationQuestion: `Which category fits this expense: ${EXPENSE_CATEGORIES.join(", ")}?` };
    return { intent: "LOG_TRANSACTION", amount, category, description, transactionType, date: null };
  }

  return {
    intent: "GENERAL",
    reply: "I can log expenses or income, update an existing savings goal, record a debt, correct a category, or show your Safe-to-Spend.",
  };
}

async function parseWithGemini(message: string): Promise<{ command: FinancialCommand; model: string; usage: { prompt: number; response: number; total: number } }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const ai = new GoogleGenAI({ apiKey });
  const today = new Date().toISOString().slice(0, 10);
  const response = await ai.models.generateContent({
    model,
    contents: message,
    config: {
      systemInstruction: `You are CASHA-BA's financial command extractor. Today is ${today}. Extract only explicit facts. Never invent an amount, category, description, goal, person, or due date. Use CLARIFY with one concise clarificationQuestion whenever a required value is missing or ambiguous. For expense dates only, use today when no date is stated. GENERAL replies must be concise and must not claim that an action occurred.`,
      responseMimeType: "application/json",
      responseJsonSchema,
      temperature: 0,
    },
  });

  const command = commandSchema.parse(JSON.parse(response.text || "{}"));
  return {
    command,
    model,
    usage: {
      prompt: response.usageMetadata?.promptTokenCount ?? 0,
      response: response.usageMetadata?.candidatesTokenCount ?? 0,
      total: response.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

async function persistTurn(
  userId: string,
  question: string,
  answer: string,
  model: string,
  usage: { prompt: number; response: number; total: number },
) {
  return prisma.aiSession.create({
    data: {
      userId,
      question,
      answer,
      model,
      promptTokens: usage.prompt,
      responseTokens: usage.response,
      totalTokens: usage.total,
    },
  });
}

export const processAiChat = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message || message.length > 1000) {
      return res.status(400).json({ message: "Message must contain between 1 and 1000 characters" });
    }

    let command: FinancialCommand;
    let model = "local-fallback";
    let usage = { prompt: 0, response: 0, total: 0 };
    try {
      const parsed = await parseWithGemini(message);
      command = parsed.command;
      model = parsed.model;
      usage = parsed.usage;
    } catch (error) {
      console.warn("Gemini parsing failed; using safe local parser", error);
      command = localFallback(message);
    }

    let reply = "";
    let safeToSpend: number | undefined;

    if (command.intent === "CLARIFY") {
      reply = command.clarificationQuestion || "Could you clarify the missing financial detail?";
    } else if (command.intent === "LOG_TRANSACTION") {
      if (!command.amount) reply = "What was the transaction amount?";
      else if (!command.transactionType) reply = "Was this income or an expense?";
      else if (!command.description) reply = "What was this transaction for?";
      else if (!command.category) reply = "Which category should I use?";
      else {
        const date = parseDate(command.date, true);
        if (!date) reply = "What date should I use? Please provide a valid date.";
        else {
          await prisma.transaction.create({
            data: {
              userId,
              amount: command.amount,
              category: command.transactionType === "INCOME" ? "Income" : command.category,
              description: command.description,
              type: command.transactionType,
              date,
            },
          });
          safeToSpend = await recalculateSafeToSpend(userId);
          reply = `Got it! Logged ${formatMoney(command.amount)} under ${command.category} — ${command.description}. Your Safe-to-Spend is now ${formatMoney(safeToSpend)}.`;
        }
      }
    } else if (command.intent === "CORRECT_CATEGORY") {
      if (!command.newCategory) reply = "Which approved category should I use?";
      else {
        const lastTransaction = await prisma.transaction.findFirst({
          where: { userId, type: "EXPENSE" },
          orderBy: { createdAt: "desc" },
        });
        if (!lastTransaction) reply = "I couldn't find a recent expense to update.";
        else {
          await prisma.transaction.update({ where: { id: lastTransaction.id }, data: { category: command.newCategory } });
          safeToSpend = await recalculateSafeToSpend(userId);
          reply = `Updated ${lastTransaction.description} from ${lastTransaction.category} to ${command.newCategory}. Your Safe-to-Spend is ${formatMoney(safeToSpend)}.`;
        }
      }
    } else if (command.intent === "ADD_SAVINGS") {
      if (!command.amount) reply = "How much would you like to add?";
      else if (!command.goalName) reply = "Which existing savings goal should receive it?";
      else {
        const goals = await prisma.savingsGoal.findMany({
          where: { userId, name: { contains: command.goalName, mode: "insensitive" } },
          take: 2,
        });
        if (goals.length === 0) reply = `I couldn't find a savings goal named “${command.goalName}”. Please create the goal first or provide its exact name.`;
        else if (goals.length > 1) reply = "I found more than one matching savings goal. What is the exact goal name?";
        else {
          const goal = goals[0];
          const currentAmount = goal.currentAmount + command.amount;
          await prisma.savingsGoal.update({
            where: { id: goal.id },
            data: { currentAmount, isCompleted: currentAmount >= goal.targetAmount },
          });
          safeToSpend = await recalculateSafeToSpend(userId);
          reply = `Added ${formatMoney(command.amount)} to ${goal.name}. Current savings: ${formatMoney(currentAmount)}. Your Safe-to-Spend is ${formatMoney(safeToSpend)}.`;
        }
      }
    } else if (command.intent === "ADD_DEBT") {
      if (!command.amount) reply = "What is the debt amount?";
      else if (!command.creditorName) reply = "Who is the creditor or borrower?";
      else if (!command.loanType) reply = "Did you borrow this amount or lend it?";
      else {
        const dueDate = parseDate(command.dueDate);
        if (!dueDate) reply = "What is the debt due date? Please provide a valid date.";
        else {
          await prisma.loan.create({
            data: {
              userId,
              title: command.loanType === "BORROWED" ? `Owe ${command.creditorName}` : `Lent to ${command.creditorName}`,
              amount: command.amount,
              type: command.loanType,
              status: "ACTIVE",
              startDate: new Date(),
              deadline: dueDate,
            },
          });
          safeToSpend = await recalculateSafeToSpend(userId);
          reply = `Recorded ${formatMoney(command.amount)} ${command.loanType === "BORROWED" ? "owed to" : "lent to"} ${command.creditorName}, due ${dueDate.toLocaleDateString("en-PH")}. Your Safe-to-Spend is ${formatMoney(safeToSpend)}.`;
        }
      }
    } else if (command.intent === "SUMMARY") {
      safeToSpend = await recalculateSafeToSpend(userId);
      const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
      reply = `Your income is ${formatMoney(setup?.totalIncome ?? 0)} and your current Safe-to-Spend is ${formatMoney(safeToSpend)}.`;
    } else {
      reply = command.reply || "How can I help you manage your finances?";
    }

    const session = await persistTurn(userId, message, reply, model, usage);
    return res.json({
      id: session.id,
      role: "assistant",
      content: reply,
      timestamp: session.createdAt,
      safeToSpend,
      requiresClarification: command.intent === "CLARIFY" || reply.endsWith("?"),
    });
  } catch (error) {
    console.error("AI command processing error", error);
    return res.status(500).json({ message: "Error processing AI chat" });
  }
};

export const getAiHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const history = await prisma.aiSession.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return res.json(history);
  } catch {
    return res.status(500).json({ message: "Error fetching AI history" });
  }
};
