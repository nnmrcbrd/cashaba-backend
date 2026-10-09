import { z } from 'zod';
import { OPERATIONS, planSchema } from './financialPlanner';

const parameterNames = Object.keys(planSchema.shape).filter(key => !['operation', 'language'].includes(key)) as [string, ...string[]];
const envelopeSchema = z.object({
  operation: planSchema.shape.operation,
  language: z.enum(['en', 'tl', 'ceb']),
  parameters: z.array(z.object({ field: z.enum(parameterNames), valueJson: z.string().min(1).max(8000) }).strict()).max(parameterNames.length),
}).strict();

// A flat object with dozens of optional properties exceeds Gemini's response
// grammar complexity even after narrowing some families (live HTTP 400).
// A field/value list with unconstrained string grammar keeps the wire small.
// Length bounds and allowed field names are enforced on the server, not in the
// provider grammar (large string bounds/field enums also triggered HTTP 400).
// without losing an operation or field. Full server validation still follows.
export function planningProviderSchema() {
  return { type: 'object', properties: { operation: { type: 'string', enum: [...OPERATIONS] },
    language: { type: 'string', enum: ['en', 'tl', 'ceb'] },
    parameters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, valueJson: { type: 'string' } },
      required: ['field', 'valueJson'], additionalProperties: false } } },
    required: ['operation', 'language', 'parameters'], additionalProperties: false };
}
export const PLANNING_PARAMETER_FORMAT = `Return operation, language and parameters array. Each item is {field,valueJson}; valueJson contains JSON text of the actual typed value (number, boolean, string, array or schedule object). For an amount, valueJson is "80000"; a frequency value is a JSON-encoded quoted string such as monthly. Use exactly these field names: ${parameterNames.join(', ')}. Omit unknown values. Do not repeat a field or put operation/language inside the list.`;
export function unwrapPlanningParameters(candidate: unknown): unknown {
  // Flat results are retained for existing local/mocked integrations; the live
  // provider is constrained to the envelope above. Both undergo planSchema.
  if (!candidate || typeof candidate !== 'object' || !('parameters' in candidate)) return candidate;
  const parsed = envelopeSchema.parse(candidate);
  const seen = new Set<string>();
  const values = parsed.parameters.map(({ field, valueJson }) => {
    if (seen.has(field)) throw new Error('DUPLICATE_PLANNING_FIELD');
    seen.add(field);
    return [field, JSON.parse(valueJson)] as const;
  });
  return { operation: parsed.operation, language: parsed.language, ...Object.fromEntries(values) };
}
