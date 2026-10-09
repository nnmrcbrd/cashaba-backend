import 'dotenv/config';
import { z } from 'zod';
import { planSchema } from '@/utils/financialPlanner';
import { generateBounded } from '@/services/aiRuntime';
import { GoogleGenAI } from '@google/genai';
import { redactIdentifiers } from '@/utils/aiSafety';
import { planningProviderSchema, PLANNING_PARAMETER_FORMAT } from '@/utils/planningProviderSchema';

// Opt-in synthetic schema diagnostic; at most three bounded provider requests.
if (process.env.AI_SCHEMA_CHECK !== '1') throw new Error('Set AI_SCHEMA_CHECK=1');
const full = z.toJSONSchema(planSchema, { unrepresentable: 'any' });
const small = planningProviderSchema();
const models = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).models;
let reserved = 0;
for (const [label, schema] of Object.entries(process.env.AI_SCHEMA_INCLUDE_FULL === '1' ? { full, small } : { small })) {
  const started = Date.now();
  try {
    const response = await generateBounded({ contents: 'Target PHP 80000, saved PHP 20000, saving PHP 4000 monthly. How long?', config: {
      responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 300,
      systemInstruction: `Extract a read-only goal timeline plan from the explicitly supplied synthetic details. ${PLANNING_PARAMETER_FORMAT} Do not invent amounts.`,
    } }, { generate: models.generateContent.bind(models), reserve: async units => { reserved += units; if (reserved > 150000) throw new Error('AI_EVALUATION_BUDGET_REACHED'); } });
    console.log(JSON.stringify({ label, elapsedMs: Date.now() - started, schemaChars: JSON.stringify(schema).length, responded: true, text: response.text, usage: response.usageMetadata }));
  } catch (error) {
    let message = error instanceof Error ? error.message : '';
    for (const secret of [process.env.GEMINI_API_KEY, process.env.DATABASE_URL]) if (secret) message = message.replaceAll(secret, '[secret]');
    let diagnostic: unknown = redactIdentifiers(message).replace(/https?:\/\/[^\s"\\]+/g, '[url]').slice(0, 1800);
    try {
      const parsed = JSON.parse(message).error;
      diagnostic = { code: parsed.code, status: parsed.status, message: parsed.message?.replace(/https?:\/\/\S+/g, '[url]'),
        quotas: parsed.details?.flatMap((item: { violations?: Array<Record<string, unknown>>; retryDelay?: string }) => item.violations?.map(violation => ({
          metric: violation.quotaMetric, dimensions: violation.quotaDimensions, value: violation.quotaValue,
        })) ?? (item.retryDelay ? [{ retryDelay: item.retryDelay }] : [])) };
    } catch { /* Safe bounded diagnostic above. */ }
    console.log(JSON.stringify({ label, elapsedMs: Date.now() - started, schemaChars: JSON.stringify(schema).length, responded: false, diagnostic }));
  }
}
