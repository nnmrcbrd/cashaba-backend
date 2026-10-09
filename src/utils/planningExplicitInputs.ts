import { planSchema, type FinancialPlan } from './financialPlanner';
import { statedGoalInputs, statedFrequency } from './planningInputs';

const inputSchema = planSchema.omit({ operation: true, language: true }).partial();
// Only current user text is parsed here. This does not read model prose/history
// or accept action/account/owner identifiers or arbitrary financial defaults.
export function explicitPlanningInputs(message: string, previousFrequency?: FinancialPlan['frequency']): Partial<Omit<FinancialPlan, 'operation' | 'language'>> {
  const label = message.match(/(?:^|\n)(?:Explicit hypothetical scenario details[^\n]*|Scenario|Planning inputs|Details)\s*:\s*(\{[\s\S]*\})\s*$/i)
    ?? message.match(/```json\s*(\{[\s\S]*\})\s*```\s*$/i)
    ?? message.match(/^\s*(\{[\s\S]*\})\s*$/);
  const text = label ? message.slice(0, label.index) : message;
  const natural: Partial<FinancialPlan> = {};
  const frequency = statedFrequency(text);
  if (frequency) natural.frequency = frequency;
  const saved = statedGoalInputs(text).saved;
  if (saved != null) natural.saved = saved;
  const date = text.match(/\b(?:first(?: contribution)?(?: date)?|start(?:ing)?(?: date)?|begin(?:ning)?)\s*(?:on|at|:|=|is)?\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1];
  if (date && (frequency ?? previousFrequency)) {
    const parsed = planSchema.shape.schedule.safeParse({ frequency: frequency ?? previousFrequency, first: date });
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
