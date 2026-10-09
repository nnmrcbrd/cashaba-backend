import type { FinancialPlan } from './financialPlanner';

const amountSource = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?';
const frequencySource = '(?:daily|weekly|monthly|(?:(?:every|each|per|a)\\s+|/\\s*)(?:day|week|month|payday)|payday)';
const frequencyValue = (value: string): FinancialPlan['frequency'] => /month/i.test(value) ? 'monthly'
  : /week/i.test(value) ? 'weekly' : /payday/i.test(value) ? 'payday' : 'daily';
const frequencies = (message: string) => [...message.matchAll(new RegExp(`(?<!\\p{L})${frequencySource}\\b`, 'giu'))];

export function statedFrequency(message: string): FinancialPlan['frequency'] {
  const values = new Set(frequencies(message).map(match => frequencyValue(match[0])));
  return values.size === 1 ? [...values][0] : undefined;
}

// A comma after an amount is punctuation; commas between digit groups are part
// of the amount. Match whole monetary tokens so malformed groups, dates,
// negative amounts, model numbers and storage capacities cannot be truncated.
export function statedRecurringAmount(message: string) {
  if (/\b(?:or|between)\b/i.test(message)) return null;
  const periods = frequencies(message), frequency = statedFrequency(message);
  if (!frequency) return null;
  const amounts = [...message.matchAll(new RegExp(`(?<![\\p{L}\\p{N}.,+\\-/])(?:₱|php\\s*|p\\s*)?(${amountSource})(?![\\p{L}\\p{N}.]|,\\d)`, 'giu'))];
  const candidates: Array<{ amount: number; frequency: NonNullable<FinancialPlan['frequency']>; start: number; end: number }> = [];
  for (const amount of amounts) for (const period of periods) {
    const amountEnd = amount.index + amount[0].length, periodEnd = period.index + period[0].length;
    const after = period.index >= amountEnd && /^[\s,:;=–—]*(?:pesos?\s*)?$/i.test(message.slice(amountEnd, period.index));
    const before = amount.index >= periodEnd && /^[\s,:;=–—]*(?:(?:(?:allocated|dedicated)\s+)?(?:savings|contribution|allocation)(?:\s+(?:is|of))?[\s,:;=–—]*)?$/i.test(message.slice(periodEnd, amount.index));
    if (after || before) {
      const value = Number(amount[1].replaceAll(',', ''));
      if (Number.isFinite(value) && value <= 999_999_999_999.99) candidates.push({ amount: value, frequency,
        start: Math.min(amount.index, period.index), end: Math.max(amountEnd, periodEnd) });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// Let the existing record-summary path answer simple lookups. Otherwise the
// planner's generic budget fallback can answer an income or wallet question.
export function isRecordedFinanceQuery(message: string) {
  const topic = '(?:income|salary|allowance|expenses|spending|savings(?: goals?| balance)?|goals|bills|obligations|debts|loans|(?:account|wallet) balances?|accounts?|wallets?|budget)';
  return new RegExp(`^(?:show(?: me)?|list|tell me(?: about)?|what(?:[’']s| is| are)|how much (?:is|are))\\s+(?:(?:all|the|my|recorded|current|saved|outstanding|unpaid|total)\\s+)*${topic}(?:\\s+(?:in total|right now|this period))?[?!.\\s]*$`, 'i').test(message)
    || /^how much (?:income )?have i (?:received|earned|spent)(?: this period)?[?!.\s]*$/i.test(message);
}

// These are statements about a read-only scenario, not ledger movements. Keep
// each amount's role so a savings balance cannot overwrite the purchase price.
export function statedGoalInputs(message: string): Partial<FinancialPlan> {
  const inputs: Partial<FinancialPlan> = {};
  if (new RegExp(`^\\s*${frequencySource}[.!\\s]*$`, 'i').test(message)) inputs.frequency = statedFrequency(message);
  const number = `(?:₱|php\\s*)?(${amountSource})(?![\\p{L}\\p{N}]|[.,]\\d)`;
  const connector = '\\s*(?:is|of|at|:|=)?\\s*';
  const amountAfter = (label: string) => {
    const match = message.match(new RegExp(`\\b(?:${label})${connector}${number}`, 'iu'));
    return match ? Number(match[1].replaceAll(',', '')) : undefined;
  };
  inputs.target = amountAfter('target(?: price| amount)?|price|costs?|worth|priced at');
  const namedPrice = message.match(/^\s*([^:]+):\s*(?:₱|php\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.,])\s*[.!]?\s*$/i);
  if (inputs.target == null && namedPrice && /\p{L}/u.test(namedPrice[1])
    && !/\b(?:sav(?:e|ed|ing|ings)|balance|allocat(?:ed|ion)|contribution|income|salary|allowance|bill|debt|loan|rent|budget|expense|fund|payment)\b/i.test(namedPrice[1])) {
    inputs.target = Number(namedPrice[2].replaceAll(',', ''));
  }
  inputs.saved = amountAfter('(?:already |currently )?saved(?: amount| balance)?|current savings|dedicated savings|savings balance');
  inputs.contribution = amountAfter('(?:monthly|weekly|daily) (?:savings|allocation|contribution)|allocated savings|savings allocation|contribution(?: amount)?');
  if (inputs.contribution != null && /\b(?:monthly|weekly|daily) (?:savings|allocation|contribution)\b/i.test(message)) {
    inputs.frequency = /\bmonthly\b/i.test(message) ? 'monthly' : /\bweekly\b/i.test(message) ? 'weekly' : 'daily';
  }
  const recurring = statedRecurringAmount(message);
  if (recurring) {
    const extra = /\b(?:extra|more|additional)\b/i.test(message.slice(0, recurring.start));
    inputs[extra ? 'delta' : 'contribution'] = recurring.amount;
    inputs.frequency = recurring.frequency;
    // "Monthly savings: 1000" describes a contribution, not money already saved.
    if (inputs.saved === inputs.contribution && /\b(?:monthly|weekly|daily) (?:allocated |dedicated )?savings\b/i.test(message)) delete inputs.saved;
  }
  if (/\b(?:monthly|weekly|daily) (?:allocated |dedicated )?savings\b/i.test(message)) {
    const amount = amountAfter('(?:monthly|weekly|daily) (?:allocated |dedicated )?savings');
    if (amount != null) {
      inputs.contribution = amount;
      inputs.frequency = /\bmonthly\b/i.test(message) ? 'monthly' : /\bweekly\b/i.test(message) ? 'weekly' : 'daily';
      delete inputs.saved;
    }
  }
  // Zero is an explicit user fact here; an absent database row is never zero.
  if (/\b(?:haven[’']?t|havent|have not|has not|didn[’']?t|didnt|did not|don[’']?t|dont|do not)\s+(?:have\s+(?:any\s+)?savings|(?:been\s+)?sav(?:e|ed|ing)\s+(?:anything|any money|any amount|yet))\b|\b(?:nothing|zero)\s+(?:is\s+)?saved\b|\b(?:saved|savings(?: balance)?(?: is)?)\s*(?:is\s+)?(?:nothing|none|zero)\b|\bno\s+(?:money\s+)?(?:saved|savings)\s*(?:yet|for (?:this|it|the))\b|\bwala pa (?:akong ipon|koy (?:natigom|tigom))\b/i.test(message)) inputs.saved = 0;
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => value != null));
}

const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function mentionsGoal(message: string, name: string) {
  return (` ${normalized(message)} `).includes(` ${normalized(name)} `);
}
