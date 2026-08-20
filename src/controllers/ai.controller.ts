import { Request, Response } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "@/lib/prisma";
import { recalculateSafeToSpend, getSafeToSpend } from "@/utils/safeToSpend";

export const processAiChat = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ message: "Message string is required" });
    }

    const apiKey = process.env.GEMINI_API_KEY || "";
    let replyContent = "";
    let actionResult: { intent?: string; safeToSpend?: number } = {};

    let parsedResult: {
      intent?: "LOG_TRANSACTION" | "CORRECT_CATEGORY" | "ADD_SAVINGS" | "ADD_DEBT" | "SUMMARY" | "GENERAL";
      amount?: number;
      category?: string;
      description?: string;
      type?: "INCOME" | "EXPENSE";
      goalName?: string;
      debtorCreditor?: string;
      dueDate?: string;
      newCategory?: string;
      reply?: string;
    } | null = null;

    // 1. Try Gemini API
    if (apiKey && apiKey !== "dummy_gemini_api_key_here") {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `You are CASHA-BA AI financial assistant.
Analyze this user command: "${message}".
Classify the user intent and output ONLY a single JSON object.

Intents:
1. LOG_TRANSACTION: User is logging an income or expense (e.g. "Spent 150 on groceries", "Received 5000 salary", "Paid 500 for electric bill").
   Format: {"intent": "LOG_TRANSACTION", "amount": number, "category": "Food & Dining" | "Transport" | "Utilities" | "Housing" | "Health" | "Entertainment" | "Education" | "Shopping" | "Savings" | "Debt Payment" | "Others", "description": string, "type": "INCOME" | "EXPENSE"}

2. CORRECT_CATEGORY: User is correcting a previous category (e.g., "that should be Transport not Food", "change category to Utilities").
   Format: {"intent": "CORRECT_CATEGORY", "newCategory": string}

3. ADD_SAVINGS: User is contributing to a savings goal (e.g., "Add 500 to Emergency Fund", "Save 1000 for Vacation").
   Format: {"intent": "ADD_SAVINGS", "amount": number, "goalName": string}

4. ADD_DEBT: User is recording a loan/debt (e.g., "I owe 2000 to Anna due July 30", "Lent 500 to John").
   Format: {"intent": "ADD_DEBT", "amount": number, "debtorCreditor": string, "type": "BORROWED" | "LENT", "dueDate": string}

5. SUMMARY: User asks for financial summary or Safe-to-Spend (e.g., "Show my summary", "How much can I spend?").
   Format: {"intent": "SUMMARY"}

6. GENERAL: General financial questions or advice.
   Format: {"intent": "GENERAL", "reply": string}
`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          parsedResult = JSON.parse(jsonMatch[0]);
        }
      } catch (geminiError) {
        console.warn("Gemini API call failed, falling back to local heuristic", geminiError);
      }
    }

    // 2. Heuristic Fallback if Gemini failed or returned null
    if (!parsedResult) {
      const lower = message.toLowerCase();

      // Check correction
      const correctMatch = message.match(/should be (?:under )?([a-z &]+)/i) || message.match(/change category to ([a-z &]+)/i);
      if (correctMatch) {
        parsedResult = { intent: "CORRECT_CATEGORY", newCategory: correctMatch[1].trim() };
      }
      // Check savings
      else if (lower.includes("add") && (lower.includes("to emergency") || lower.includes("savings") || lower.includes("fund") || lower.includes("goal"))) {
        const amtMatch = message.match(/(\d+(?:\.\d+)?)/);
        const goalMatch = message.match(/to (.*)/i);
        parsedResult = {
          intent: "ADD_SAVINGS",
          amount: amtMatch ? parseFloat(amtMatch[1]) : 0,
          goalName: goalMatch ? goalMatch[1].trim() : "Emergency Fund",
        };
      }
      // Check debt
      else if (lower.includes("owe") || lower.includes("lent") || lower.includes("borrowed")) {
        const amtMatch = message.match(/(\d+(?:\.\d+)?)/);
        const personMatch = message.match(/(?:to|from)\s+([a-zA-Z]+)/);
        parsedResult = {
          intent: "ADD_DEBT",
          amount: amtMatch ? parseFloat(amtMatch[1]) : 0,
          debtorCreditor: personMatch ? personMatch[1] : "Friend",
          type: lower.includes("lent") ? "LENT" : "BORROWED",
        };
      }
      // Check summary
      else if (lower.includes("summary") || lower.includes("safe to spend") || lower.includes("how much")) {
        parsedResult = { intent: "SUMMARY" };
      }
      // Transaction logging
      else {
        const match = message.match(/(?:spent|bought|paid|add|income|receive|received)?\s*₱?\s*(\d+(?:\.\d+)?)\s*(?:for|on)?\s*(.*)/i);
        if (match) {
          const amount = parseFloat(match[1]);
          const description = match[2].trim() || "Expense";
          const isIncome = /salary|income|gift|deposit|receive|received/i.test(message);

          let category = isIncome ? "Income" : "Food & Dining";
          if (/grocer|food|meal|dinner|lunch|coffee|jollibee/i.test(message)) category = "Food & Dining";
          else if (/transport|grab|ride|gas|fuel|fare/i.test(message)) category = "Transport";
          else if (/electric|water|bill|utility|meralco/i.test(message)) category = "Utilities";

          parsedResult = {
            intent: "LOG_TRANSACTION",
            amount,
            category,
            description,
            type: isIncome ? "INCOME" : "EXPENSE",
          };
        } else {
          parsedResult = { intent: "GENERAL", reply: `I received: "${message}". How can I help you manage your finances today?` };
        }
      }
    }

    // 3. Process Intent
    if (parsedResult?.intent === "LOG_TRANSACTION" && parsedResult.amount) {
      const type = parsedResult.type || "EXPENSE";
      const category = parsedResult.category || (type === "INCOME" ? "Income" : "Others");
      const description = parsedResult.description || "Logged via AI";
      const amount = parsedResult.amount;

      await prisma.transaction.create({
        data: {
          userId,
          amount,
          category,
          description,
          type,
          date: new Date(),
        },
      });

      const safeToSpend = await recalculateSafeToSpend(userId);
      replyContent = `Got it! Logged ₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} under ${category} — "${description}".\nYour Safe-to-Spend is now ₱${safeToSpend.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
      actionResult = { intent: "LOG_TRANSACTION", safeToSpend };
    }
    else if (parsedResult?.intent === "CORRECT_CATEGORY" && parsedResult.newCategory) {
      const lastTx = await prisma.transaction.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      if (lastTx) {
        const updated = await prisma.transaction.update({
          where: { id: lastTx.id },
          data: { category: parsedResult.newCategory },
        });
        const safeToSpend = await getSafeToSpend(userId);
        replyContent = `Updated! Changed category of "${updated.description}" from ${lastTx.category} to ${updated.category}.`;
        actionResult = { intent: "CORRECT_CATEGORY", safeToSpend };
      } else {
        replyContent = "I couldn't find a recent transaction to update.";
      }
    }
    else if (parsedResult?.intent === "ADD_SAVINGS" && parsedResult.amount) {
      const goalName = parsedResult.goalName || "Emergency Fund";
      const amount = parsedResult.amount;

      // Find or create goal
      let goal = await prisma.savingsGoal.findFirst({
        where: { userId, name: { contains: goalName, mode: "insensitive" } },
      });

      if (!goal) {
        goal = await prisma.savingsGoal.create({
          data: {
            userId,
            name: goalName,
            targetAmount: amount * 5,
            currentAmount: amount,
          },
        });
      } else {
        const newAmt = goal.currentAmount + amount;
        goal = await prisma.savingsGoal.update({
          where: { id: goal.id },
          data: {
            currentAmount: newAmt,
            isCompleted: newAmt >= goal.targetAmount,
          },
        });
      }

      const safeToSpend = await recalculateSafeToSpend(userId);
      replyContent = `Great! Added ₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} to "${goal.name}". (Current saved: ₱${goal.currentAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })})\nYour Safe-to-Spend is now ₱${safeToSpend.toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
      actionResult = { intent: "ADD_SAVINGS", safeToSpend };
    }
    else if (parsedResult?.intent === "ADD_DEBT" && parsedResult.amount) {
      const person = parsedResult.debtorCreditor || "Friend";
      const amount = parsedResult.amount;
      const loanType = parsedResult.type || "BORROWED";

      await prisma.loan.create({
        data: {
          userId,
          title: loanType === "BORROWED" ? `Owe ${person}` : `Lent to ${person}`,
          amount,
          type: loanType,
          status: "ACTIVE",
          startDate: new Date(),
          deadline: parsedResult.dueDate ? new Date(parsedResult.dueDate) : new Date(Date.now() + 14 * 86400000),
        },
      });

      const safeToSpend = await getSafeToSpend(userId);
      replyContent = `Recorded! ${loanType === "BORROWED" ? "You owe" : "Lent"} ₱${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} ${loanType === "BORROWED" ? "to" : "to"} ${person}.`;
      actionResult = { intent: "ADD_DEBT", safeToSpend };
    }
    else if (parsedResult?.intent === "SUMMARY") {
      const safeToSpend = await recalculateSafeToSpend(userId);
      const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
      const recentTx = await prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 3,
      });

      replyContent = `📊 **Financial Summary**:\n• Total Income: ₱${(setup?.totalIncome || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}\n• Safe-to-Spend: ₱${safeToSpend.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n• Recent Transactions: ${recentTx.map(t => `${t.description} (₱${t.amount})`).join(', ') || 'None'}`;
      actionResult = { intent: "SUMMARY", safeToSpend };
    }
    // Premium: DAILY_BRIEF — proactive financial morning briefing
    else if (
      message.toLowerCase().includes("brief") ||
      message.toLowerCase().includes("morning") ||
      message.toLowerCase().includes("good morning") ||
      message.toLowerCase().includes("status update")
    ) {
      const safeToSpend = await recalculateSafeToSpend(userId);
      const setup = await prisma.incomeSetup.findUnique({ where: { userId } });
      const loans = await prisma.loan.findMany({
        where: { userId, status: { in: ["ACTIVE", "OVERDUE"] } },
        orderBy: { deadline: "asc" },
        take: 3,
      });
      const now = new Date();
      const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });

      const dueSoon = loans.filter((l) => {
        const diff = (l.deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        return diff >= 0 && diff <= 3;
      });

      const greetHour = now.getHours();
      const greeting = greetHour < 12 ? "Good morning" : greetHour < 17 ? "Good afternoon" : "Good evening";

      replyContent = `${greeting}! ☀️ Here's your ${dayOfWeek} financial brief:\n\n💰 **Safe-to-Spend:** ₱${safeToSpend.toLocaleString('en-US', { minimumFractionDigits: 2 })}\n📊 **Monthly Income:** ₱${(setup?.totalIncome || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}${dueSoon.length > 0 ? `\n\n⚠️ **Upcoming Payments (next 3 days):**\n${dueSoon.map(l => `• ${l.title} — ₱${l.amount.toLocaleString()} due ${new Date(l.deadline).toLocaleDateString("en-PH")}`).join("\n")}` : "\n\n✅ No payments due in the next 3 days."}\n\nStay on track today! You can log expenses, check savings, or ask me anything. 🚀`;
      actionResult = { intent: "SUMMARY", safeToSpend };
    }
    else {
      replyContent = parsedResult?.reply || `I heard: "${message}". You can ask me to log expenses, add savings, record debts, or check your Safe-to-Spend!`;
    }

    // Store in AiSession database
    const session = await prisma.aiSession.create({
      data: {
        userId,
        question: message,
        answer: replyContent,
        model: "gemini-1.5-flash",
        promptTokens: 0,
        responseTokens: 0,
        totalTokens: 0,
      },
    });

    res.json({
      id: session.id,
      role: "assistant",
      content: replyContent,
      timestamp: session.createdAt,
      safeToSpend: actionResult.safeToSpend,
    });
  } catch (error) {
    console.error("AI Controller Error:", error);
    res.status(500).json({ message: "Error processing AI chat" });
  }
};

export const getAiHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id || req.user!.userId;
    const history = await prisma.aiSession.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: "Error fetching AI history" });
  }
};
