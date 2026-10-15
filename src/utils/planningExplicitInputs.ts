import { planSchema, type FinancialPlan } from './financialPlanner';
import { statedGoalInputs, statedFrequency } from './planningInputs';

const inputSchema = planSchema.omit({ operation: true, language: true }).partial();
const detailsLabel = (message: string) => message.match(/(?:^|\s)(?:Explicit hypothetical scenario details[^\n:]*|Scenario|Planning inputs|Details)\s*:\s*(\{[\s\S]*\})\s*$/i)
  ?? message.match(/```json\s*(\{[\s\S]*\})\s*```\s*$/i)
  ?? message.match(/^\s*(\{[\s\S]*\})\s*$/);

export function isStructuredPlanningReply(message: string) {
  const label = detailsLabel(message);
  if (!label || message.slice(0, label.index).trim()) return false;
  try { return inputSchema.safeParse(JSON.parse(label[1])).success; } catch { return false; }
}
// Only current user text is parsed here. This does not read model prose/history
// or accept action/account/owner identifiers or arbitrary financial defaults.
export function explicitPlanningInputs(message: string, previousFrequency?: FinancialPlan['frequency']): Partial<Omit<FinancialPlan, 'operation' | 'language'>> {
  // Stop the label at its colon. Letting it consume the JSON can select an
  // inner schedule object and discard the surrounding saved amount and dates.
  const label = detailsLabel(message);
  const text = label ? message.slice(0, label.index) : message;
  const natural: Partial<FinancialPlan> = {};
  const moneyAfter = (label: string) => {
    const match = text.match(new RegExp(`\\b(?:${label})\\s*(?:is|of|:|=)?\\s*(?:₱|php\\s*)?((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?)(?![\\p{L}\\p{N}]|[.,]\\d)`, 'iu'));
    if (!match) return undefined;
    const parsed = planSchema.shape.income.safeParse(Number(match[1].replaceAll(',', '')));
    return parsed.success ? parsed.data : undefined;
  };
  const costAmounts = {
    target: moneyAfter('full (?:move-in |moving |rental |new |scenario )?cost|new full costs?|move-in total'),
    alternativeCost: moneyAfter('current (?:full |total )?costs?|alternative costs?'),
    income: moneyAfter('current (?:monthly |weekly |take-home )*(?:income|salary|pay)'),
    newIncome: moneyAfter('(?:new|proposed) (?:monthly |weekly |take-home )*(?:income|salary|pay)'),
  };
  Object.assign(natural, Object.fromEntries(Object.entries(costAmounts).filter(([, value]) => value != null)));
  const frequency = statedFrequency(text);
  if (frequency) natural.frequency = frequency;
  const saved = statedGoalInputs(text).saved;
  if (saved != null) natural.saved = saved;
  const date = text.match(/\b(?:first(?: contribution)?(?: date)?|start(?:ing)?(?: date)?|begin(?:ning)?)\s*(?:(?:will be|is|on|at|:|=)\s*)*(\d{4}-\d{2}-\d{2})\b/i)?.[1];
  const namedDate = text.match(/\b(?:first(?: contribution)?(?: date)?|start(?:ing)?(?: date)?|begin(?:ning)?)\s*(?:(?:will be|is|on|at|:|=)\s*)*((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec))\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(\d{4})\b/i);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const namedIso = namedDate ? `${namedDate[3]}-${String(months.indexOf(namedDate[1].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${namedDate[2].padStart(2, '0')}` : undefined;
  if ((date ?? namedIso) && (frequency ?? previousFrequency)) {
    const parsed = planSchema.shape.schedule.safeParse({ frequency: frequency ?? previousFrequency, first: date ?? namedIso });
    if (parsed.success) natural.schedule = parsed.data;
  }
  const periods = text.match(/\b(\d+)\s+(?:daily|weekly|monthly|payday)?\s*(?:contributions?|periods?|payments?)\b/i)?.[1]
    ?? text.match(/\b(?:periods|number of contributions)\s*[:=]\s*(\d+)\b/i)?.[1];
  if (periods && planSchema.shape.periods.safeParse(Number(periods)).success) natural.periods = Number(periods);
  // Accept explicit structured planning details, as supported by the chat's
  // read-only scenario API. Strict typed validation rejects malformed amounts,
  // unknown fields, impossible dates and executable/action instructions.
  if (!label) return natural;
  try {
    const parsed = inputSchema.safeParse(JSON.parse(label[1]));
    return parsed.success ? { ...natural, ...parsed.data } : natural;
  } catch { return natural; }
}
