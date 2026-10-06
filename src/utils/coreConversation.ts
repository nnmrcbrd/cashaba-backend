import { z } from 'zod';
import { conversationFollowUp, personalFinanceReply, personalQuestionTopic, type AdviceFacts, type PersonalTopic } from './personalFinanceAdvice';
import { safeQualitativeReply } from './aiSafety';

const topics = ['help', 'transactions', 'transfers', 'analytics', 'registration', 'income', 'spending', 'budget', 'savings', 'debts', 'bills', 'accounts', 'safe-to-spend'] as const;
export type CoreTopic = typeof topics[number];
const contextSchema = z.object({ kind: z.literal('CORE_CONVERSATION'), topic: z.enum(topics), updatedAt: z.string().datetime() });
export type CoreContext = z.infer<typeof contextSchema>;
export function isClearlyOffTopic(message: string) {
  return !/casha.?ba|financ|budget|saving|expense|income|debt|loan|bill|money|wallet|account|spend|goal|afford|price|purchase/i.test(message)
    && /\b(?:weather|capital of|poem|lyrics|recipe|sports score|homework|write (?:an? )?(?:essay|code)|politics|president of)\b/i.test(message);
}
export function readCoreContext(value: unknown, now = Date.now()): CoreContext | null {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) return null;
  const age = now - Date.parse(parsed.data.updatedAt);
  return age >= -60_000 ? parsed.data : null;
}

// Product facts are maintained alongside the routes. They describe existing
// features; the model cannot invent navigation or execute these instructions.
export const CORE_KNOWLEDGE: Record<CoreTopic, string> = {
  help: 'Casha-Ba helps track received income, spending, wallets, budgets, savings goals, bills and debts. The dashboard shows Safe-to-Spend. The assistant explains records, plans purchases and prepares financial actions for confirmation. It does not access bank balances automatically or buy things.',
  transactions: 'Money → Transaction History → Add transaction records received income or an expense. Choose the actual amount, account, category and date. Transfer moves between accounts; Adjust balance corrects a recorded balance. Undo last reverses the most recent entry. Search and filters locate entries. Print / Save PDF exports history. Import CSV previews a statement before import. Scan receipt extracts a draft for review. Chat actions require Confirm and save.',
  transfers: 'Money → Transaction History → Transfer moves money from one recorded account to another. Select source, destination, actual amount and date. A transfer is not income or spending. In chat, name both accounts and review the preview before Confirm and save.',
  analytics: 'Intelligence → Financial Review compares recorded income and expenses for the selected period, shows category spending, monthly budget usage and savings progress. The income versus expenses chart uses recorded income and expenses including bill and debt payments; planned income, transfers and loan principal collected are not earnings. A single day with entries can show a single pair of bars. Changing the period changes the records being compared.',
  registration: 'Email registration requires the emailed verification code before sign-in and onboarding. Forgot password uses an emailed verification code before setting a new password. Onboarding collects planning information; planned income is not an income transaction. The assistant cannot view codes, change credentials or verify email on behalf of the user.',
  income: 'Planned income is an expected weekly or monthly amount. Received income is money actually recorded. Money → Transaction History → Add transaction → Income records it in the correct account. Safe-to-Spend uses recorded received income for the current income period, not expected income or opening balances.',
  spending: 'Money → Transaction History shows expenses, bill payments and debt payments. Record real spending with amount, category, account and date. Review essential bills before discretionary purchases. Missing entries mean the system cannot see those expenses.',
  budget: 'Planning → Budget & Goals stores the monthly spending limit. Budget usage compares that limit with recorded monthly expenses, bill payments and debt payments. A limit is a plan, not money added to a wallet. Safe-to-Spend separately reserves commitments for the current income period.',
  savings: 'Planning → Budget & Goals stores a goal name, target and monthly allocation. Allocation is a planned reserve, not saved money. Record a savings contribution from an account when money is actually set aside; that updates goal progress. A purchase timeline uses target minus that matching goal’s saved balance, divided by monthly saving, rounded up. With no matching goal, ask for price and monthly saving. Never use another goal’s savings without the user selecting it.',
  debts: 'Planning → Obligations & Debts tracks money borrowed and money lent. Borrowed means owed by the user; lent means owed to the user. Pay debt records a repayment from an account. Collect loan records principal coming back into an account; principal returned is not earned income. Due borrowed repayments are reserved in Safe-to-Spend.',
  bills: 'Planning → Obligations & Debts → Add obligation stores bill name, amount, due date, category and frequency. Pay bill records an actual payment from an account. Unpaid due bills, arrears and recurring occurrences are reserved in Safe-to-Spend; paying a bill updates the balance and installment.',
  accounts: 'Money → Wallet & Accounts stores Cash, bank and e-wallet accounts with opening balances and recorded movements. Liability accounts represent money owed. Opening balance describes existing money, not current-period income. A wallet balance and Safe-to-Spend can differ because Safe-to-Spend uses period income and reserves commitments.',
  'safe-to-spend': 'Safe-to-Spend equals recorded received income minus unpaid bill reserves, savings reserves, due debt reserves and recorded spending for the current income period. Negative results display zero available; the shortfall is shown in the breakdown. Planned income and opening balances are separate. Recording income, spending, contributions and payments recalculates it.',
};

export function coreTopic(message: string, previous?: CoreContext | null): CoreTopic {
  if (/\b(?:csv|receipt|transaction history|transaction|undo|categor(?:y|ies)|export|print|pdf)\b/i.test(message)) return 'transactions';
  if (/\b(?:transfers?|move money)\b/i.test(message)) return 'transfers';
  if (/\b(?:analytics|financial review|charts?|graphs?|period comparison)\b/i.test(message)) return 'analytics';
  if (/\b(?:register|registration|verification|otp|password|onboarding|sign.?in|sign.?up)\b/i.test(message)) return 'registration';
  const personal = personalQuestionTopic(message);
  if (personal && personal !== 'timeline') return personal;
  for (const topic of ['budget', 'savings', 'income', 'spending', 'debts', 'bills', 'accounts'] as const) {
    if (new RegExp(`\\b${topic === 'accounts' ? 'wallet|account|balance' : topic === 'debts' ? 'debt|loan|owe' : topic === 'savings' ? 'saving|save|goal' : topic}\\w*\\b`, 'i').test(message)) return topic;
  }
  if (conversationFollowUp(message) || /^(?:and|so|then|okay|ok)\b|\b(?:that|this|it)\b|\b(?:advise|advice|suggest|recommend)\b/i.test(message)) return previous?.topic ?? 'help';
  return 'help';
}

export function isCoreQuestion(message: string) {
  return !!conversationFollowUp(message) || /^(?:how|why|what|which|when|can|could|would|is|are|do|does|will|show|tell|explain|define|help|teach|guide|ano|paano|bakit|magkano|hi|hello|hey|thanks|thank you)\b/i.test(message)
    || /\b(?:question|advice|suggestion|confused|understand|not working|doesn.t work)\b/i.test(message);
}

export function coreReply(message: string, facts: AdviceFacts, previous?: CoreContext | null) {
  const topic = isClearlyOffTopic(message) ? 'help' : coreTopic(message, previous);
  const context: CoreContext = { kind: 'CORE_CONVERSATION', topic, updatedAt: new Date().toISOString() };
  const followUp = conversationFollowUp(message);
  const howTo = /\b(?:how (?:do(?:es)?|can|to)|where|steps?|guide|start|use|create|set up|add|record|work|meaning|difference|definition)\b/i.test(message) || followUp === 'next';
  let content: string;
  if (isClearlyOffTopic(message)) content = 'I focus on Casha-Ba and your recorded finances. I can help with budgeting, savings, Safe-to-Spend, accounts, transactions, bills and debts.';
  else if (/^(?:thanks|thank you|salamat)\b/i.test(message)) content = 'You’re welcome. You can keep asking about the same plan or another part of Casha-Ba.';
  else if (/^(?:hi|hello|hey)[!.,\s]*$/i.test(message)) content = 'Hi! What would you like help with—understanding your finances, using Casha-Ba, or planning a savings goal?';
  else if (topic === 'help') content = 'I can help with Casha-Ba’s budgets, savings plans, Safe-to-Spend, accounts, transactions, bills and debts. What would you like to understand or do?';
  else if (followUp === 'simple') {
    const simple: Record<Exclude<CoreTopic, 'help'>, string> = {
      budget: facts.budget ? `Your budget is a spending limit, not extra cash. You set ${php(facts.budget.target)} for this month and have spent ${php(facts.budget.spent)}. ${facts.budget.spent > facts.budget.target ? `That is ${php(facts.budget.spent - facts.budget.target)} over your limit.` : `You have ${php(facts.budget.target - facts.budget.spent)} left within that limit.`}\n\nSafe-to-Spend tells you what is available after commitments; it is currently ${php(facts.breakdown.safeToSpend)}.` : 'A budget is a limit you choose for monthly spending. It does not put money into an account. Set the limit in Planning → Budget & Goals.',
      income: `Planned income is what you expect to receive. Recorded income is what you actually received and entered.\n\nYou recorded ${php(facts.breakdown.actualIncome)} this period. Expected income does not become spendable until you record receiving it.`,
      spending: `Spending is money you recorded leaving your accounts for expenses, bills and debt payments. You recorded ${php(facts.breakdown.totalExpenses)} this period.\n\nOpen Transaction History to see the individual entries; the system only knows the spending you enter.`,
      savings: 'A savings allocation is your plan to set money aside. A contribution means you actually saved money and recorded it.\n\nCreate a goal in Planning → Budget & Goals, then record contributions to update its progress.',
      accounts: `An account balance is the money recorded in that account, including its starting balance and later entries.\n\n${facts.accounts.length ? facts.accounts.slice(0, 4).map(account => `${account.name}: ${php(account.balance)}${account.kind === 'LIABILITY' ? ' (owed)' : ''}`).join('\n') : 'You have no accounts recorded yet.'}\n\nIt can differ from Safe-to-Spend because some money is reserved for commitments.`,
      debts: 'Borrowed money is money you owe someone. Lent money is money someone owes you.\n\nUse Pay debt when you repay them, and Collect loan when they repay you. Returning loan principal is not earned income.',
      bills: 'A bill is something you need to pay. Adding it tells Casha-Ba to reserve money for it; it does not record a payment.\n\nWhen you actually pay, use Pay bill in Obligations & Debts and choose the account the money came from.',
      'safe-to-spend': `Safe-to-Spend is what remains from received income after spending and money reserved for commitments. Yours is ${php(facts.breakdown.safeToSpend)}.\n\nExpected income and account opening balances are separate. The dashboard breakdown shows the deductions.`,
      transactions: 'A transaction is an entry for money received, spent, saved, paid or transferred. A chat question or a savings estimate does not create an entry.\n\nTo record one, give the amount, purpose, account and date, then review the preview before confirming.',
      transfers: 'A transfer moves your own money between your recorded accounts. It does not mean you earned or spent it.\n\nChoose the account it leaves, the account it enters, the amount and date in Transaction History → Transfer.',
      analytics: 'Financial Review uses the entries you recorded for the selected period. The left chart compares income received with spending, including bill and debt payments.\n\nPlanned income and transfers are excluded. Change the period to review different dates.',
      registration: 'Check your inbox for the verification code and enter it on the verification screen. The code confirms you can access that email.\n\nFor a forgotten password, verify the emailed code before setting a new password.',
    };
    content = simple[topic];
  }
  else if (topic === 'transactions' || topic === 'transfers' || topic === 'analytics' || topic === 'registration') content = CORE_KNOWLEDGE[topic];
  else if (howTo) {
    content = CORE_KNOWLEDGE[topic];
    if (topic === 'safe-to-spend') content = `In simpler terms, it is what is left from received income after spending and money reserved for commitments. Your Safe-to-Spend is ${php(facts.breakdown.safeToSpend)}.\n\nExpected income and opening balances do not count as received income. Open the dashboard breakdown to see what is being deducted.`;
    if (topic === 'budget' && facts.budget) content += `\n\nYour monthly limit is ${php(facts.budget.target)} and spending this month is ${php(facts.budget.spent)}.`;
    if (topic === 'savings') content += facts.breakdown.safeToSpend === 0 ? '\n\nYour current Safe-to-Spend is ₱0.00. Review received income and commitments before planning an extra contribution.' : `\n\nYour current Safe-to-Spend is ${php(facts.breakdown.safeToSpend)}; check upcoming commitments before choosing a saving amount.`;
  } else content = personalFinanceReply(topic as PersonalTopic, message, facts);
  return { content, context };
}
const php = (amount: number) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(amount);

// Replace numeric facts before asking the provider to write conversational prose.
// Only the backend can render their values; malformed/unknown references fail closed.
export function groundReply(text: string) {
  const values: Record<string, string> = {};
  const template = text.replace(/CASHA_ENTITY_\d+|(?:₱|PHP\s*)?-?\d[\d,]*(?:\.\d+)?%?/gi, value => {
    const key = `fact_${Object.keys(values).length}`;
    values[key] = value;
    return `[[${key}]]`;
  });
  return { template, values };
}
export function renderGroundedReply(value: unknown, values: Record<string, string>): string | null {
  if (typeof value !== 'string' || value.length > 1800) return null;
  // Some provider responses copy a verified value literally. Accept it only
  // when its complete amount and unit match a server value; render canonically.
  // An amount from history or an invented amount is never an allowed value.
  const normalized = (text: string) => {
    if (text.startsWith('CASHA_ENTITY_')) return text;
    const number = text.replace(/PHP\s*/i, '₱').replaceAll(',', '');
    return `${number.startsWith('₱') ? 'money' : number.endsWith('%') ? 'percent' : 'count'}:${Number(number.replace(/[₱%]/g, ''))}`;
  };
  const referenced = value.replace(/\[\[[^\]]+\]\]|CASHA_ENTITY_\d+|(?:₱|PHP\s*)?-?\d[\d,]*(?:\.\d+)?%?/gi, literal => {
    if (literal.startsWith('[[')) return literal;
    const entry = Object.entries(values).find(([, trusted]) => normalized(trusted) === normalized(literal));
    return entry ? `[[${entry[0]}]]` : literal;
  });
  let unknown = false;
  const qualitative = referenced.replace(/\[\[([^\]]+)\]\]/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) unknown = true;
    return '';
  });
  if (unknown || /\[\[|\]\]|CASHA_ENTITY_|\b(?:hundred|thousand|million|billion|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:pesos|months?|years?|days?|weeks?|percent)\b|\b(?:i (?:have )?|i.ve |successfully )(?:recorded|saved|transferred|paid|deleted|updated|created)\b|\b(?:your|the)\b.{0,50}\b(?:has|have|was|were) (?:been )?(?:recorded|saved|transferred|paid|deleted|updated|created)\b/i.test(qualitative) || !safeQualitativeReply(qualitative)) return null;
  return referenced.replace(/\[\[([^\]]+)\]\]/g, (_, key: string) => values[key]).trim();
}
