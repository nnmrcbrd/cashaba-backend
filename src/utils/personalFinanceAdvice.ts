import { roundMoney, WEEKS_PER_MONTH } from './money';
import type { SafeToSpendBreakdown } from './safeToSpend';
import { z } from 'zod';
import type { PlanningFacts } from './planningFacts';
import { statedRecurringAmount, isWalletBalanceLookup, isRecordedIncomeExpenseLookup } from './planningInputs';
import { businessDateLabel } from './calendar';

export type PersonalTopic = 'timeline' | 'savings' | 'income' | 'spending' | 'budget' | 'debts' | 'bills' | 'accounts' | 'safe-to-spend';
export interface AdviceFacts {
  planning?: PlanningFacts;
  breakdown: SafeToSpendBreakdown;
  incomePeriod: 'weekly' | 'monthly';
  goals: Array<{ name: string; target: number; saved: number; monthlyAllocation: number }>;
  budget: { target: number; spent: number } | null;
  accounts: Array<{ name: string; balance: number; kind: string; accountType?: string }>;
  loans: Array<{ name: string; remaining: number; type: string }>;
  bills: Array<{ name: string; remaining: number }>;
}
const php = (amount: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount);
const monthAmount = (amount: number, period: 'weekly' | 'monthly') => roundMoney(amount * (period === 'weekly' ? WEEKS_PER_MONTH : 1));

// Recognize questions before the action parser sees words such as "income" or
// "save". Explicit commands still use the existing preview/confirmation flow.
export function personalQuestionTopic(message: string): PersonalTopic | null {
  if (!isExplicitFinancialAction(message) && statedAllocation(message) && /\b(?:save|saving|set aside|put aside)\b/i.test(message)) return 'timeline';
  if (/^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:log|record|add|transfer|move|pay|save|undo|correct)\b/i.test(message)) return null;
  if (!/^(?:how|why|what|which|when|can|could|is|are|do|does|would|will|show|tell|explain|ano|ilang|kailan|bakit|paano|magkano|ngano(?:ng)?|unsa(?:y|on)?|pila|asa|kanus.a)\b/i.test(message)) return null;
  if (/how (?:long|soon)|how many (?:months|weeks|years)|when|ilang (?:buwan|taon)|kailan/i.test(message) && /buy|afford|save|savings|goal|phone|bili|ipon/i.test(message)) return 'timeline';
  if (/safe[\s-]*to[\s-]*spend|how much can i spend/i.test(message)) return 'safe-to-spend';
  if (/savings?|goals?|fund|ipon/i.test(message)) return 'savings';
  if (/budget/i.test(message)) return 'budget';
  if (/debts?|loans?|owe|utang/i.test(message)) return 'debts';
  if (/bills?|obligations?/i.test(message)) return 'bills';
  if (/wallets?|accounts?|balances?/i.test(message)) return 'accounts';
  if (/income|salary|allowance|earned|kita/i.test(message)) return 'income';
  if (/spend|spent|expenses?|gastos/i.test(message)) return 'spending';
  if (/afford|buy|bili/i.test(message)) return 'timeline';
  return null;
}

function matchingGoals(message: string, goals: AdviceFacts['goals']) {
  const normalized = message.toLowerCase();
  const exact = goals.filter(goal => new RegExp(`(?<![\\p{L}\\p{N}])${goal.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(message));
  if (exact.length) return exact;
  const words = normalized.match(/[a-z]{3,}/g) ?? [];
  const relevant = words.filter(word => !['how', 'many', 'months', 'will', 'take', 'for', 'the', 'can', 'buy', 'save', 'savings', 'goal', 'latest', 'long', 'does', 'much', 'need', 'afford', 'until', 'please', 'what'].includes(word));
  return goals.filter(goal => relevant.some(word => goal.name.toLowerCase().includes(word)) || (/\b(?:iphone|phone|smartphone|cellphone)\b/.test(normalized) && /\b(?:iphone|phone|smartphone|cellphone)\b/i.test(goal.name)));
}

const MAX_AMOUNT = 999_999_999_999.99;
const adviceContextSchema = z.object({
  kind: z.literal('SAVINGS_PLAN'),
  originalQuestion: z.string().min(1).max(1000),
  awaiting: z.enum(['price', 'allocation', 'goal', 'change']).nullable(),
  price: z.number().positive().max(MAX_AMOUNT).optional(),
  monthlyAllocation: z.number().min(0).max(MAX_AMOUNT).optional(),
  weeklyAllocation: z.number().min(0).max(MAX_AMOUNT).optional(),
  goalName: z.string().min(1).max(200).optional(),
  ignoreExistingGoals: z.boolean().optional(),
  updatedAt: z.string().datetime(),
});
export type AdviceContext = z.infer<typeof adviceContextSchema>;
export interface AdviceTurn { content: string; context: AdviceContext | null; requiresClarification: boolean }
export interface AdviceHistoryTurn { question: string; model: string; state: string; pendingAction: unknown }

export function readAdviceContext(value: unknown, now = Date.now()): AdviceContext | null {
  const result = adviceContextSchema.safeParse(value);
  if (!result.success) return null;
  const age = now - Date.parse(result.data.updatedAt);
  // Read-only planning assumptions survive reloads and pauses. Financial facts
  // are fetched again each turn; cancel/new topics explicitly reset context.
  return age >= -60_000 && age <= 30 * 60_000 ? result.data : null;
}

export function statedPlanningAmount(message: string): number | null {
  const match = message.trim().match(/^(?:₱|php\s*|p\s*)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:pesos)?[.!]?$/i);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT ? value : null;
}

function statedAllocation(message: string) {
  const match = statedRecurringAmount(message);
  if (!match || !['monthly', 'weekly'].includes(match.frequency)) return null;
  const amount = statedPlanningAmount(String(match.amount));
  const weekly = match.frequency === 'weekly';
  const monthly = amount == null ? null : roundMoney(amount * (weekly ? WEEKS_PER_MONTH : 1));
  return monthly != null && monthly <= MAX_AMOUNT ? { monthly, weekly: weekly ? amount! : undefined, start: match.start, end: match.end } : null;
}

function explicitPrice(message: string) {
  // Do not mistake a model number, month count or calendar date for a price.
  const allocation = statedAllocation(message);
  const pattern = /(?:₱|php\s*|(?:costs?|priced?\s+at|worth|price\s*(?:is|of|:))\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.,])/gi;
  for (const match of message.matchAll(pattern)) {
    if (allocation && match.index >= allocation.start && match.index < allocation.end) continue;
    const amount = statedPlanningAmount(match[1]);
    if (amount != null && amount > 0) return amount;
  }
  return null;
}

export function isExplicitFinancialAction(message: string) {
  // Saving "per month" is a planning assumption unless the user specifies an
  // account/goal/date for a contribution. It must not become a ledger entry.
  if (statedRecurringAmount(message) && !/\b(?:from|into|today|yesterday|record|log|transfer|paid|received)\b/i.test(message)) return false;
  return /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:i\s+)?(?:log|record|add|transfer|move|pay|paid|save|saved|spent|bought|received|earned|borrowed|lent|owe|collected|undo|correct|nagastos|gumastos|natanggap|ilipat|bayaran)\b/i.test(message);
}

export function transactionExplanation(message: string): string | null {
  return /^(?:what\s+(?:(?:do\s+(?:you|u)|does\s+that)\s+mean\s+by|(?:is|are))|explain|define|meaning\s+of)\s+(?:(?:a|an|the|financial)\s+)*transactions?\b/i.test(message.trim())
    ? 'A transaction is a financial entry you record, such as received income, an expense, a transfer or a savings contribution. Asking about an item price or a savings timeline does not record a purchase or move money.' : null;
}

export function conversationFollowUp(message: string): 'simple' | 'why' | 'next' | 'faster' | 'retry' | null {
  // These are requests to address the preceding question, not new financial
  // inputs or permission to replay an action. Keep the match to whole short
  // utterances so a new question or command still determines its own intent.
  if (/^(?:(?:i[’']?m|im|i am) asking(?: you)?|(?:please )?(?:answer|respond to) (?:my|the) question(?: please)?|(?:you )?(?:did(?:n[’']?t|nt)|did not|haven[’']?t|have not) answer(?:ed)?(?: my question)?|(?:that[’']?s|that is|this is|this[’']?s) not what i asked|(?:you(?:[’']?re| are)? )?(?:stupid|dumb|useless)|sayop(?: gihapon)?(?: imong tubag)?|pataka(?: lang)?(?: ka)?(?: ug tubag)?)[?!.\s]*$/i.test(message.trim())) return 'retry';
  if (/\b(?:don[’']?t|dont|do not|didn[’']?t|didnt)\s+(?:get|understand)|\b(?:confused|simpler|simply|simple terms|simplify|plain english|beginner|explain again|explain (?:that|it|this)|what does (?:that|it|this) mean|what do (?:you|u) mean|hindi ko (?:gets|maintindihan)|wala ko kasabot|wa ko kasabot|wako kasabot)\b|^what[?!\s]*$/i.test(message)) return 'simple';
  if (/^(?:why|bakit|ngano(?:ng)?)\b|\bhow (?:did you|is that|come)|\bwhere did .+ come from/i.test(message)) return 'why';
  if (/\b(?:faster|sooner|shorten|speed up|too long|quicker)\b/i.test(message)) return 'faster';
  if (/^(?:how|paano)[?!\s]*$|^unsaon(?: mana| na| ni)?[?!\s]*$|\b(?:what (?:now|next)|next steps?|what should i do|how do i (?:do|start)|step by step|guide me)\b/i.test(message)) return 'next';
  return null;
}

function duration(months: number) {
  if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(months / 12), rest = months % 12;
  return `${years} year${years === 1 ? '' : 's'}${rest ? ` and ${rest} month${rest === 1 ? '' : 's'}` : ''}`;
}

function planningTurn(context: AdviceContext, facts: AdviceFacts, followUp: ReturnType<typeof conversationFollowUp> = null): AdviceTurn {
  context = { ...context, updatedAt: new Date().toISOString() };
  const candidates = context.ignoreExistingGoals ? [] : matchingGoals(context.originalQuestion, facts.goals);
  const selected = context.goalName ? facts.goals.filter(goal => goal.name.toLowerCase() === context.goalName!.toLowerCase()) : candidates;
  if (selected.length > 1) return { content: `More than one saved goal matches this purchase: ${selected.map(goal => `“${goal.name}”`).join(', ')}. Which goal should I use? You can also say “new purchase” to plan without using an existing goal balance.`, context: { ...context, awaiting: 'goal' }, requiresClarification: true };
  const goal = selected[0];
  if (goal) context.goalName = goal.name;
  const target = context.price ?? goal?.target;
  const saved = goal?.saved ?? 0;
  const allocation = context.monthlyAllocation ?? goal?.monthlyAllocation ?? 0;
  if (target == null) return { content: 'I can work that out. I need the phone/item price first because I cannot look up or assume the latest price.\n\nWhat is its price in pesos? You can reply with just the amount.', context: { ...context, awaiting: 'price' }, requiresClarification: true };
  const remaining = roundMoney(Math.max(0, target - saved));
  if (remaining === 0) return { content: `${goal ? `Your “${goal.name}” goal has` : 'The target has'} ${php(saved)} saved against ${php(target)}, so no additional saving is needed for that target. Review where those saved funds are held before making the purchase.`, context: { ...context, awaiting: null }, requiresClarification: false };
  if (allocation <= 0) return { content: `${goal ? `You have ${php(saved)} saved for “${goal.name}”. You still need ${php(remaining)}.` : `The price is ${php(target)}. I found no saved goal for this purchase, so the estimate starts from zero.`}\n\nNo monthly allocation is set yet. How much can you set aside each month? You can reply with just the amount.`, context: { ...context, awaiting: 'allocation' }, requiresClarification: true };
  const months = Math.ceil(Math.round(remaining * 100) / Math.round(allocation * 100));
  const headline = `${followUp === 'simple' ? 'In simpler terms: ' : ''}saving ${php(allocation)} each month would take about ${months} month${months === 1 ? '' : 's'}${months >= 12 ? ` (${duration(months)})` : ''} to reach ${goal ? `your “${goal.name}” goal` : 'the purchase price'}.`;
  const calculation = `The target is ${php(target)}. You need ${php(remaining)} more${saved > 0 ? ` after the ${php(saved)} already saved` : ''}. ${php(remaining)} ÷ ${php(allocation)} per month = ${months} months, rounded up.`;
  let content = `${headline}\n\n${calculation}`;
  if (followUp === 'faster') {
    const quicker = Math.ceil(Math.round(remaining * 100) / Math.round(allocation * 200));
    content = `A higher monthly saving amount or a cheaper purchase would shorten the timeline. For example, ${php(roundMoney(allocation * 2))} per month would take about ${quicker} months (${duration(quicker)}), compared with ${months} months now.\n\nWhat monthly amount would you like me to compare?`;
  } else if (followUp === 'next') {
    content = `To track this plan in Casha-Ba:\n- Open Planning → Budget & Goals${goal ? ` and review “${goal.name}”` : ' and add a savings goal'}.\n- Use ${php(target)} as the target and ${php(allocation)} as the monthly allocation.\n- Record a contribution from the correct account whenever you actually save money.\n\nThe allocation is your plan; contributions update your saved balance. The estimate is ${months} months (${duration(months)}).`;
  } else if (followUp !== 'simple') {
    if (context.weeklyAllocation != null) content += `\n\nYour ${php(context.weeklyAllocation)} weekly plan is converted using 52 weeks ÷ 12 months.`;
    content += facts.breakdown.safeToSpend === 0 ? '\n\nYour current Safe-to-Spend is ₱0.00, so this is a future saving plan, not money available now.' : '\n\nThis assumes you can make every planned contribution.';
  } else content = `In simpler terms: at ${php(allocation)} per month, saving the remaining ${php(remaining)} would take about ${months} months (${duration(months)}).\n\nTo reach it sooner, you would need to save more each month or choose a lower target. This is a future saving estimate; I haven’t recorded a purchase.`;
  return { content, context: { ...context, awaiting: null }, requiresClarification: false };
}

export function personalAdviceTurn(message: string, facts: AdviceFacts, previous?: AdviceContext | null): AdviceTurn | null {
  if (isExplicitFinancialAction(message)) return null;
  const explanation = transactionExplanation(message);
  if (explanation) {
    if (!previous) return { content: explanation, context: null, requiresClarification: false };
    const turn = planningTurn(previous, facts);
    return { ...turn, content: `${explanation}\n\n${turn.content}` };
  }
  const topic = personalQuestionTopic(message);
  const amount = statedPlanningAmount(message);
  const allocation = statedAllocation(message);
  const price = explicitPrice(message);
  const followUp = conversationFollowUp(message);
  const adjustsPlan = previous && (allocation || price != null) && /\b(?:what if|what about|instead|i can|i will|how long|how many)\b/i.test(message);
  if (topic && topic !== 'timeline' && !adjustsPlan) return { content: personalFinanceReply(topic, message, facts), context: null, requiresClarification: false };
  const knownGoal = facts.goals.find(goal => goal.name.toLowerCase() === message.trim().toLowerCase());
  const followsUp = previous && (amount != null || allocation || price != null || knownGoal || followUp || /\b(?:how long|how many|what if|what about|per month|per week|monthly|weekly|price|cost|instead|not sure|don.t know|new purchase)\b/i.test(message));
  if (!topic && !followsUp) return null;
  const newPurchase = topic === 'timeline' && (!previous || (/\b(?:buy|afford|purchase|get)\b/i.test(message) && !/\b(?:it|that|this|same)\b/i.test(message)));
  const context: AdviceContext = newPurchase ? { kind: 'SAVINGS_PLAN', originalQuestion: message, awaiting: 'price', updatedAt: new Date().toISOString() } : previous ? { ...previous } : { kind: 'SAVINGS_PLAN', originalQuestion: message, awaiting: 'price', updatedAt: new Date().toISOString() };
  if (knownGoal && previous?.awaiting === 'goal') context.goalName = knownGoal.name;
  if (/\bnew purchase\b/i.test(message)) { context.ignoreExistingGoals = true; delete context.goalName; }
  if (price != null) context.price = price;
  else if (amount != null && previous?.awaiting === 'price' && amount > 0) context.price = amount;
  if (allocation) { context.monthlyAllocation = allocation.monthly; context.weeklyAllocation = allocation.weekly; }
  else if (amount != null && previous?.awaiting === 'allocation') { context.monthlyAllocation = amount; delete context.weeklyAllocation; }
  else if (amount != null && previous && (previous.awaiting == null || previous.awaiting === 'change')) return { content: `Does ${php(amount)} mean a new purchase price or a monthly savings amount? Say “price is ${amount}” or “${amount} per month” so I can recalculate the same plan.`, context: { ...context, awaiting: 'change', updatedAt: new Date().toISOString() }, requiresClarification: true };
  return planningTurn(context, facts, followUp);
}

// Recover older advice turns as well as new typed context, using only this
// user's stored conversation. The caller supplies a small chronological window.
export function recoverAdviceContext(history: AdviceHistoryTurn[], facts: AdviceFacts): AdviceContext | null {
  let context: AdviceContext | null = null;
  for (const turn of history) {
    if (turn.state === 'CANCELLED' || isExplicitFinancialAction(turn.question)) { context = null; continue; }
    const stored = readAdviceContext(turn.pendingAction);
    if (stored) { context = stored; continue; }
    if (turn.pendingAction && typeof turn.pendingAction === 'object' && 'kind' in turn.pendingAction) { context = null; continue; }
    if (turn.model === 'local-personal-finance-v1' && personalQuestionTopic(turn.question) === 'timeline') {
      context = personalAdviceTurn(turn.question, facts)?.context ?? null;
      continue;
    }
    if (context) context = personalAdviceTurn(turn.question, facts, context)?.context ?? null;
  }
  return context;
}

function timelineReply(message: string, facts: AdviceFacts) {
  return personalAdviceTurn(message, facts)!.content;
}

export function personalFinanceReply(topic: PersonalTopic, message: string, facts: AdviceFacts): string {
  const b = facts.breakdown;
  if (isWalletBalanceLookup(message)) {
    const liquid = facts.accounts.filter(account => account.kind === 'ASSET' && ['CASH', 'BANK', 'EWALLET'].includes(account.accountType ?? ''));
    const borrowed = facts.accounts.filter(account => account.kind === 'LIABILITY' || ['LOAN', 'CREDIT_CARD'].includes(account.accountType ?? ''));
    const available = roundMoney(liquid.reduce((sum, account) => sum + Math.max(0, account.balance), 0));
    const personalDebt = roundMoney(facts.loans.filter(loan => loan.type === 'BORROWED').reduce((sum, loan) => sum + loan.remaining, 0));
    return `Your recorded accessible wallet balances total ${php(available)}.${liquid.length ? `\n${liquid.map(account => `• ${account.name}: ${php(account.balance)}.`).join('\n')}` : '\nNo accessible cash, bank or e-wallet accounts are recorded.'}\n\nLoan, credit and liability accounts are excluded from available cash.${borrowed.length ? `\n${borrowed.map(account => `• ${account.name}: ${php(account.balance)} (excluded).`).join('\n')}` : ''}\nRemaining recorded personal loans borrowed: ${php(personalDebt)}. These balances are separate from Safe-to-Spend and do not prove a purchase is affordable.`;
  }
  if (isRecordedIncomeExpenseLookup(message)) {
    if (/this month/i.test(message) && facts.planning) {
      const today = businessDateLabel(new Date(facts.planning.asOf));
      const entries = facts.planning.spending.filter(row => row.date.startsWith(today.slice(0, 7)) && row.date <= today);
      const income = roundMoney(entries.filter(row => row.type === 'INCOME').reduce((sum, row) => sum + row.amount, 0));
      const spending = roundMoney(entries.filter(row => ['EXPENSE', 'BILL_PAYMENT', 'DEBT_PAYMENT'].includes(row.type)).reduce((sum, row) => sum + row.amount, 0));
      return `This month through ${today}, your recorded received income is ${php(income)} and recorded expenses are ${php(spending)}, including bill and debt payments. Planned income, opening balances and transfers are excluded. Missing entries do not prove zero real income or expenses.`;
    }
    return `For your current ${facts.incomePeriod === 'weekly' ? 'weekly' : 'monthly'} income period, recorded received income is ${php(b.actualIncome)} and recorded expenses are ${php(b.totalExpenses)}, including bill and debt payments. Planned income, opening balances and transfers are excluded. Missing entries do not prove zero real income or expenses.`;
  }
  if (topic === 'timeline') return timelineReply(message, facts);
  if (topic === 'income') return `Your planned income is ${php(b.configuredIncome)} per ${facts.incomePeriod === 'weekly' ? 'week' : 'month'} (${php(monthAmount(b.configuredIncome, facts.incomePeriod))} monthly equivalent). You recorded ${php(b.actualIncome)} of received income this period. Safe-to-Spend uses received income, not the plan. If you have received money, record an income transaction in the correct account.`;
  if (topic === 'savings') return facts.goals.length ? `Your saved goals:\n${facts.goals.map(goal => `• ${goal.name}: ${php(goal.saved)} of ${php(goal.target)}; monthly allocation ${php(goal.monthlyAllocation)}.`).join('\n')}\nAllocations are plans; saved balances come from recorded contributions.` : 'You have no saved savings goals. Add a target and monthly allocation in Budget & Goals, then record contributions when you actually save money.';
  if (topic === 'budget') return facts.budget ? `Your current Manila-calendar month budget is ${php(facts.budget.target)}. Recorded spending this month is ${php(facts.budget.spent)}, leaving ${php(Math.max(0, facts.budget.target - facts.budget.spent))}${facts.budget.spent > facts.budget.target ? `; you are over budget by ${php(facts.budget.spent - facts.budget.target)}` : ''}. A budget limit is a spending plan; current Safe-to-Spend is ${php(b.safeToSpend)}.` : 'You have no budget saved for the current Manila-calendar month. Set one in Budget & Goals; a limit is a plan, not received cash.';
  if (topic === 'accounts') return facts.accounts.length ? `Your recorded account balances:\n${facts.accounts.map(account => `• ${account.name}: ${php(account.balance)}${account.kind === 'LIABILITY' ? ' (liability)' : ''}.`).join('\n')}\nAccount balances include opening balances and recorded movements; Safe-to-Spend also reserves commitments and uses period income.` : 'You have no accounts saved. Add Cash, bank or e-wallet accounts in Wallet & Accounts and enter their actual opening balances.';
  if (topic === 'debts') return facts.loans.length ? `Your active loans:\n${facts.loans.map(loan => `• ${loan.name}: ${php(loan.remaining)} ${loan.type === 'BORROWED' ? 'still owed by you' : 'still owed to you'}.`).join('\n')}\nDebt repayments reserved this period: ${php(b.totalLoanRepayments)}.` : 'You have no active borrowed or lent loans recorded.';
  if (topic === 'bills') return facts.bills.length ? `Your unpaid obligations:\n${facts.bills.map(bill => `• ${bill.name}: ${php(bill.remaining)} remaining on the current installment.`).join('\n')}\nBills reserved through this period, including arrears and recurring occurrences: ${php(b.totalFixed)}.` : 'You have no unpaid obligations recorded. Add your actual bills in Obligations & Debts so they can be reserved.';
  if (topic === 'spending') return `You recorded ${php(b.totalExpenses)} in expenses, bill payments and debt payments this ${facts.incomePeriod === 'weekly' ? 'week' : 'month'}. Received income is ${php(b.actualIncome)}. ${b.totalExpenses === 0 ? 'There are no recorded expenses in this period; that does not prove you have no real expenses.' : 'Review Transaction History for the entries behind this total.'}`;
  return `Your Safe-to-Spend is ${php(b.safeToSpend)}. Calculation for this ${facts.incomePeriod === 'weekly' ? 'week' : 'month'}: received income ${php(b.totalIncome)} − unpaid bill reserves ${php(b.totalFixed)} − savings reserves ${php(b.totalSavings)} − debt reserves ${php(b.totalLoanRepayments)} − recorded spending ${php(b.totalExpenses)} = ${php(b.rawSafeToSpend)}.${b.rawSafeToSpend < 0 ? ` The shortfall is ${php(-b.rawSafeToSpend)}; the dashboard shows zero available.` : ''} Planned income ${php(b.configuredIncome)} is shown separately and becomes spendable only when received income is recorded.`;
}
