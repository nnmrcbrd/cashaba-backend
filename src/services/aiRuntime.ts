import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse, type EmbedContentParameters, type EmbedContentResponse } from '@google/genai';
import type { Request, Response, NextFunction } from 'express';
import { prisma, qualifiedTable } from '@/lib/prisma';

function limit(name: string, fallback: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
export function aiLimits() { return {
  question: limit('AI_QUESTION_CHARS', 2000, 2000), history: limit('AI_HISTORY_MESSAGES', 6, 6),
  historyMessage: limit('AI_HISTORY_MESSAGE_CHARS', 1500, 1500), context: limit('AI_CONTEXT_CHARS', 18000, 24000),
  request: limit('AI_REQUEST_CHARS', 32000, 40000), output: limit('AI_OUTPUT_TOKENS', 1200, 1800),
  deadline: limit('AI_DEADLINE_MS', 25000, 45000), timeout: limit('AI_ATTEMPT_TIMEOUT_MS', 8000, 15000),
  attempts: limit('AI_MAX_ATTEMPTS', 2, 3), dailyTokens: limit('AI_DAILY_TOKEN_CAP', 250000, 10000000),
}; }
type RequestScope = { signal: AbortSignal; deadline: number; attempts: number; embeddings: number };
const scope = new AsyncLocalStorage<RequestScope>();
// Attach before any chat handlers. One budget/deadline covers extraction and
// prose, including retries. Aborts cancel the SDK HTTP request, not just a race.
export function aiRequestScope(req: Request, res: Response, next: NextFunction) {
  const controller = new AbortController(), ttl = aiLimits().deadline;
  const timer = setTimeout(() => controller.abort(), ttl); timer.unref();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableEnded) abort(); clearTimeout(timer); req.off('aborted', abort); };
  req.once('aborted', abort); res.once('close', close); res.once('finish', () => clearTimeout(timer));
  scope.run({ signal: controller.signal, deadline: Date.now() + ttl, attempts: 0, embeddings: 0 }, next);
}
export function boundedHistory(history: Array<{ question: string; answer: string }>) {
  const limits = aiLimits();
  return history.flatMap(turn => [{ role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer }])
    .slice(-limits.history).map(item => ({ ...item, content: item.content.slice(0, limits.historyMessage) }));
}
export function transientStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const object = error as { status?: number; code?: number; response?: { status?: number } };
  const code = Number(object.status ?? object.response?.status ?? object.code);
  return [429, 500, 502, 503, 504].includes(code) ? code : null;
}
export function retryDelay(error: unknown, attempt: number, random = Math.random()) {
  const headers = (error as { response?: { headers?: Record<string, string> }; headers?: Record<string, string> })?.response?.headers
    ?? (error as { headers?: Record<string, string> })?.headers;
  const retry = headers?.['retry-after'];
  const wait = retry ? Number.isFinite(Number(retry)) ? Number(retry) * 1000 : Date.parse(retry) - Date.now() : 0;
  let providerWait = 0;
  // The Gemini SDK exposes quota RetryInfo in its JSON error message, often
  // without HTTP headers. Honor it instead of spending another attempt during
  // the same quota window. The shared deadline prevents long blocking waits.
  try {
    const message = (error as { message?: unknown })?.message;
    if (typeof message === 'string' && message.length < 32000) {
      const details = JSON.parse(message)?.error?.details;
      if (Array.isArray(details)) for (const detail of details) {
        if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
        const duration = typeof detail.retryDelay === 'string' ? detail.retryDelay.match(/^(\d+(?:\.\d+)?)s$/) : null;
        if (duration) providerWait = Math.max(providerWait, Math.min(600000, Number(duration[1]) * 1000));
      }
    }
  } catch { /* A non-JSON diagnostic supplies no trusted retry interval. */ }
  return Math.max(0, Number.isFinite(wait) ? wait : 0, providerWait, Math.min(3000, 250 * 2 ** attempt + Math.floor(random * 250)));
}
// Conservative token reservations remain spent even when the provider fails:
// a transport failure may still incur cost. Shared across processes/workers.
export async function reserveAiTokens(units: number, now = new Date()) {
  const max = aiLimits().dailyTokens;
  const rows = await prisma.$queryRawUnsafe<Array<{ hits: number }>>(
    `INSERT INTO ${qualifiedTable('RateLimitBucket')} AS bucket ("key", "hits", "expiresAt")
     SELECT $1::text, $2::integer, date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day' WHERE $2::integer <= $3::integer
     ON CONFLICT ("key") DO UPDATE SET "hits" = bucket."hits" + $2
     WHERE bucket."hits" + $2::integer <= $3::integer RETURNING "hits"`,
    `ai-token-cap:${now.toISOString().slice(0, 10)}`, units, max,
  );
  if (units > max || !rows.length) throw new Error('AI_GLOBAL_BUDGET_REACHED');
}
export type Generate = (parameters: GenerateContentParameters) => Promise<GenerateContentResponse>;
export async function generateBounded(parameters: Omit<GenerateContentParameters, 'model'> & { model?: string },
  dependencies?: { generate: Generate; reserve: (units: number) => Promise<void>; signal?: AbortSignal }) {
  const limits = aiLimits(), request = scope.getStore() ?? { signal: dependencies?.signal ?? AbortSignal.timeout(limits.deadline), deadline: Date.now() + limits.deadline, attempts: 0, embeddings: 0 };
  const model = parameters.model || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const fallback = process.env.GEMINI_FALLBACK_MODEL;
  // No automatic Pro fallback. An explicit fallback must be in the operator's
  // allowlist and is still subject to the same attempts/output/daily budget.
  const allowed = (process.env.AI_ALLOWED_MODELS || model).split(',').map(value => value.trim());
  if (!allowed.includes(model)) throw new Error('AI_MODEL_NOT_ALLOWED');
  const serialized = JSON.stringify(parameters);
  if (serialized.length > limits.request) throw new Error('AI_CONTEXT_TOO_LARGE');
  if (JSON.stringify(parameters.contents).length > limits.context) throw new Error('AI_CONTEXT_TOO_LARGE');
  const output = Math.min(parameters.config?.maxOutputTokens ?? limits.output, limits.output);
  const models = dependencies ? null : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).models;
  const generate = dependencies?.generate ?? models!.generateContent.bind(models);
  const reserve = dependencies?.reserve ?? reserveAiTokens;
  let last: unknown;
  while (request.attempts < limits.attempts && Date.now() < request.deadline && !request.signal.aborted) {
    const attempt = request.attempts++;
    const controller = new AbortController();
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    const timeout = Math.min(limits.timeout, request.deadline - Date.now());
    const timer = setTimeout(abort, timeout); timer.unref();
    try {
      // Four UTF-8 bytes per JS code unit is a conservative input token bound.
      await reserve(serialized.length * 4 + output);
      if (request.signal.aborted || controller.signal.aborted) throw new Error('AI_DEADLINE');
      return await generate({ ...parameters, model: attempt > 0 && fallback && allowed.includes(fallback) ? fallback : model,
        config: { ...parameters.config, maxOutputTokens: output, abortSignal: controller.signal,
          // Gemini rejects service deadlines below ten seconds. Keep the
          // shorter client/request deadline in the AbortController above.
          httpOptions: { timeout: Math.max(10_000, timeout), retryOptions: { attempts: 1 } } } });
    } catch (error) {
      last = error;
      if (!transientStatus(error)) throw error;
    } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
    const wait = retryDelay(last, attempt);
    if (request.attempts >= limits.attempts || Date.now() + wait >= request.deadline) break;
    await delay(wait, undefined, { signal: request.signal });
  }
  throw last ?? new Error('AI_DEADLINE');
}

export type Embed = (parameters: EmbedContentParameters) => Promise<EmbedContentResponse>;
export async function embedBounded(contents: string, dependencies?: { embed?: Embed; reserve?: (units: number) => Promise<void>; signal?: AbortSignal }) {
  const limits = aiLimits(), request = scope.getStore();
  if (contents.length > 2400) throw new Error('AI_EMBEDDING_INPUT_INVALID');
  if (request && request.embeddings++ >= 1) throw new Error('AI_EMBEDDING_REQUEST_LIMIT');
  const remaining = request ? request.deadline - Date.now() : limits.deadline;
  const signal = AbortSignal.any([request?.signal ?? AbortSignal.timeout(limits.deadline), dependencies?.signal ?? AbortSignal.timeout(limits.deadline), AbortSignal.timeout(Math.max(1, Math.min(limits.timeout, remaining)))]);
  if (remaining <= 0 || signal.aborted) throw new Error('AI_DEADLINE');
  await (dependencies?.reserve ?? reserveAiTokens)(contents.length * 4);
  if (signal.aborted) throw new Error('AI_DEADLINE');
  const models = dependencies?.embed ? null : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).models;
  const embed = dependencies?.embed ?? models!.embedContent.bind(models);
  return embed({ model: 'gemini-embedding-2', contents, config: { outputDimensionality: 768, abortSignal: signal,
    httpOptions: { timeout: Math.max(10000, Math.min(limits.timeout, remaining)), retryOptions: { attempts: 1 } } } });
}

export async function reserveIndexingTokens(units: number, now = new Date()) {
  const maximum = limit('AI_INDEXING_DAILY_TOKEN_CAP', 1000000, 5000000);
  const rows = await prisma.$queryRawUnsafe<Array<{ hits: number }>>(
    `INSERT INTO ${qualifiedTable('RateLimitBucket')} AS bucket ("key", "hits", "expiresAt")
     SELECT $1::text, $2::integer, date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day' WHERE $2::integer <= $3::integer
     ON CONFLICT ("key") DO UPDATE SET "hits" = bucket."hits" + $2
     WHERE bucket."hits" + $2::integer <= $3::integer RETURNING "hits"`,
    `ai-indexing-cap:${now.toISOString().slice(0, 10)}`, units, maximum,
  );
  if (units > maximum || !rows.length) throw new Error('AI_INDEXING_BUDGET_REACHED');
}
