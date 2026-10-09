import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GoogleGenAI } from '@google/genai';
import type { Request, Response } from 'express';
import dataset from '@/evaluation/aiQuestions.v1.json';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from '@/services/financialPlanner';
import { aiLimits, aiRequestScope, type Generate } from '@/services/aiRuntime';
import { aliasFinancialContext, redactIdentifiers } from '@/utils/aiSafety';
import { executeFinancialPlan } from '@/utils/financialPlanner';
import { unwrapPlanningParameters } from '@/utils/planningProviderSchema';
import { dailyProviderQuota } from '@/evaluation/providerQuota';
import { retrieveRagContext } from '@/services/ragRetrieval';
import { generateEmbedding } from '@/services/embedding';
import { KnowledgeBaseRepository, KnowledgeDocumentRepository } from '@/repositories/knowledge.repository';
import { prisma } from '@/lib/prisma';

// Real provider calls, synthetic evidence only. No account or ledger writes.
if (process.env.AI_LIVE_EVAL !== '1' || !process.env.GEMINI_API_KEY) throw new Error('Live evaluation requires AI_LIVE_EVAL=1 and GEMINI_API_KEY');
const count = Number(process.env.AI_LIVE_EVAL_QUESTIONS);
const cap = Number(process.env.AI_LIVE_EVAL_TOKEN_CAP);
const concurrency = Number(process.env.AI_LIVE_EVAL_CONCURRENCY || 1);
const scenarioDelay = Number(process.env.AI_LIVE_EVAL_SCENARIO_DELAY_MS || 6500);
if (!Number.isInteger(count) || count < 1 || count > 150 || !Number.isSafeInteger(cap) || cap < 1
  || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3
  || !Number.isInteger(scenarioDelay) || scenarioDelay < 0 || scenarioDelay > 60000) throw new Error('Set explicit questions (1–150), token cap, concurrency (1–3) and scenario delay (0–60000)');
const output = resolve(process.env.AI_LIVE_EVAL_OUTPUT || 'ai-live-evaluation.json');
mkdirSync(dirname(output), { recursive: true });
const models = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).models;
let startedAt = new Date().toISOString();
const implementationDigest = createHash('sha256').update(['src/services/financialPlanner.ts', 'src/services/planningResponse.ts',
  'src/services/aiRuntime.ts', 'src/utils/financialPlanner.ts', 'src/utils/planningProviderSchema.ts', 'src/utils/planningInputs.ts',
  'src/utils/planningIntent.ts', 'src/utils/planningExplicitInputs.ts',
  'src/services/ragRetrieval.ts', 'src/services/embedding.ts', 'src/repositories/knowledge.repository.ts',
  'src/utils/rag.ts', 'src/utils/assistantKnowledge.ts', 'prisma/schema.prisma', 'src/scripts/evaluate-ai-live.ts',
  'src/evaluation/planningFixtures.ts', 'src/evaluation/aiQuestions.v1.json'].map(path => readFileSync(path, 'utf8')).join('\n')).digest('hex');
let reserved = 0, next = 0, fatal: string | null = null, unavailableScenarios = 0, cooldownUntil = 0;
type Row = typeof dataset.questions[number];
type ProviderCall = { phase: string; elapsedMs: number; responded: boolean; text?: string; error?: string;
  usage?: { prompt: number; response: number; total: number } };
type Scenario = Awaited<ReturnType<typeof evaluate>>;
const results: Array<{ id: number; question: string; complete: Scenario; incomplete: Scenario }> = [];
const availabilityRetries: Array<{ id: number; mode: 'complete' | 'incomplete'; at: string; previous: Scenario }> = [];
const resumeHistory: Array<{ at: string; completedQuestions: number; extraReservation: number; scenarioDelay: number }> = [];
const providerQuotaEvents: Array<NonNullable<ReturnType<typeof dailyProviderQuota>> & { observedAt: string }> = [];
if (process.env.AI_LIVE_EVAL_RESUME === '1' && existsSync(output)) {
  const saved = JSON.parse(readFileSync(output, 'utf8'));
  if (saved.implementationDigest !== implementationDigest || saved.requestedQuestions !== count
    || saved.model !== (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite') || !Array.isArray(saved.results)
    || JSON.stringify(saved.limits) !== JSON.stringify(aiLimits())
    || !Number.isSafeInteger(saved.reservedTokenBound) || saved.reservedTokenBound > cap
    || saved.results.some((row: { id?: number }) => !Number.isInteger(row.id) || row.id! < 1 || row.id! > count)
    || new Set(saved.results.map((row: { id: number }) => row.id)).size !== saved.results.length) throw new Error('Resume report does not match the current implementation/model or budget');
  results.push(...saved.results); reserved = saved.reservedTokenBound; startedAt = saved.startedAt;
  availabilityRetries.push(...(saved.availabilityRetries ?? [])); resumeHistory.push(...(saved.resumeHistory ?? []));
  providerQuotaEvents.push(...(saved.providerQuotaEvents ?? []));
  // Older checkpoints only persisted reservations after a completed question.
  // Conservatively cover every possible in-flight call in that question.
  const extraReservation = saved.reservationsCheckpointed ? 0 : 4 * (aiLimits().request * 4 + aiLimits().output);
  if (reserved + extraReservation > cap) throw new Error('Resume requires room for uncheckpointed token reservations');
  reserved += extraReservation;
  resumeHistory.push({ at: new Date().toISOString(), completedQuestions: results.length, extraReservation, scenarioDelay });
}
const answered = (scenario: Scenario) => scenario.calls.some(call => call.phase !== 'embedding' && call.responded);
const retryUnavailable = process.env.AI_LIVE_EVAL_RETRY_UNANSWERED === '1';
const pending = dataset.questions.slice(0, count).filter(row => {
  const previous = results.find(result => result.id === row.id);
  return !previous || retryUnavailable && (!answered(previous.complete) || !answered(previous.incomplete));
});

function safeError(error: unknown) {
  const status = Number((error as { status?: number })?.status);
  const message = error instanceof Error ? error.message : '';
  if (/^AI_[A-Z_]+$/.test(message)) return message;
  if (Number.isInteger(status) && status >= 100 && status < 600) return `HTTP_${status}`;
  return error instanceof SyntaxError ? 'INVALID_JSON' : error instanceof Error ? error.name : 'PROVIDER_ERROR';
}
function snapshot(finished = false) {
  const scenarios = results.flatMap(row => [row.complete, row.incomplete]);
  const calls = [...scenarios, ...availabilityRetries.map(item => item.previous)].flatMap(row => row.calls);
  const generationCalls = calls.filter(call => call.phase !== 'embedding');
  const sum = (field: 'prompt' | 'response' | 'total') => calls.reduce((total, call) => total + (call.usage?.[field] ?? 0), 0);
  const report = { dataset: dataset.version, sourceSha256: dataset.sourceSha256, implementationDigest, startedAt, updatedAt: new Date().toISOString(),
    finished, completed: finished && results.length === count && !fatal, requestedQuestions: count, evaluatedQuestions: results.length, syntheticOnly: true,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', concurrency, scenarioDelay, limits: aiLimits(),
    evaluationTokenReservationCap: cap, reservedTokenBound: reserved, stoppedReason: fatal,
    reservationsCheckpointed: true, availabilityRetries, resumeHistory, providerQuotaEvents,
    usage: { prompt: sum('prompt'), response: sum('response'), total: sum('total') },
    summary: { completeFactChecksPassed: results.filter(row => row.complete.factCheck).length,
      completeOperationsMatched: results.filter(row => row.complete.operationMatches).length,
      incompleteDataChecksPassed: results.filter(row => row.incomplete.missingDataHandled).length,
      incompleteOperationsMatched: results.filter(row => row.incomplete.operationMatches).length,
      questionsWithProviderResponse: results.filter(row => [...row.complete.calls, ...row.incomplete.calls].some(call => call.phase !== 'embedding' && call.responded)).length,
      scenariosWithProviderResponse: scenarios.filter(answered).length,
      scenariosWithAcceptedExtraction: scenarios.filter(row => row.extractionAccepted).length,
      scenariosWithAcceptedExplanation: scenarios.filter(row => row.explanationAccepted).length,
      providerResponses: generationCalls.filter(call => call.responded).length, providerErrors: generationCalls.filter(call => !call.responded).length,
      embeddingResponses: calls.filter(call => call.phase === 'embedding' && call.responded).length,
      embeddingErrors: calls.filter(call => call.phase === 'embedding' && !call.responded).length,
      availabilityRetriedScenarios: availabilityRetries.length,
      fullPass: results.filter(row => row.complete.factCheck && row.complete.operationMatches && row.complete.providerAccepted
        && row.incomplete.operationMatches && row.incomplete.missingDataHandled && row.incomplete.providerAccepted).length },
    methodology: 'Original questions with complete and missing synthetic facts. Complete prompts append explicit scenario fields but omit operation, language and expected answers. Missing-data prompts contain the original question only. Real extraction, query embedding, database cosine retrieval and optional explanation share production request bounds. Embedding responses are reported separately and never count as a generated answer. Fallback is separate from accepted provider output. Expected facts reflect supplemental scenarios, not every nuance of broad coaching questions. Saved provider text is synthetic only.',
    browserAccountVerification: 'Separate; this script never accesses an actual account.', results: [...results].sort((a, b) => a.id - b.id) };
  const temporary = output + '.tmp';
  writeFileSync(temporary, JSON.stringify(report, null, 2)); renameSync(temporary, output);
  return report;
}
async function evaluate(row: Row, mode: 'complete' | 'incomplete') {
  const facts = mode === 'complete' ? completeFacts() : missingFacts();
  const before = JSON.stringify(facts);
  // Do not give Gemini the expected operation, answer, or prefilled extraction.
  const supplied = Object.fromEntries(Object.entries(row.completeInput).filter(([key]) => !['operation', 'language'].includes(key)));
  const message = mode === 'complete' && Object.keys(supplied).length
    ? `${row.question}\nExplicit hypothetical scenario details (not changes to my records): ${JSON.stringify(supplied)}` : row.question;
  if (message.length > aiLimits().question) throw new Error('Evaluation question exceeds application input limit');
  const calls: ProviderCall[] = [];
  const aliases = aliasFinancialContext(JSON.stringify({ goals: facts.goals.map(goal => ({ name: goal.name })),
    categories: [...new Set(facts.planning?.spending.map(item => item.category) ?? [])].slice(0, 40) }));
  let extractionAccepted = false, extractionRejection: string | null = null;
  const generate: Generate = async parameters => {
    const instructions = String(parameters.config?.systemInstruction ?? '');
    const phase = instructions.includes('Extract a read-only') ? 'extraction' : instructions.includes('Translate') ? 'translation' : 'explanation';
    const started = Date.now();
    try {
      const response = await models.generateContent(parameters);
      calls.push({ phase, elapsedMs: Date.now() - started, responded: true, text: response.text,
        usage: { prompt: response.usageMetadata?.promptTokenCount ?? 0, response: response.usageMetadata?.candidatesTokenCount ?? 0,
          total: response.usageMetadata?.totalTokenCount ?? 0 } });
      if (phase === 'extraction') {
        try { verifyExtractedPlan(unwrapPlanningParameters(JSON.parse(aliases.restore(response.text || '{}'))), message, localFinancialPlan(message, facts)!); extractionAccepted = true; }
        catch (error) { extractionRejection = safeError(error); }
      }
      return response;
    } catch (error) {
      const code = safeError(error);
      calls.push({ phase, elapsedMs: Date.now() - started, responded: false, error: code });
      if (process.env.AI_LIVE_EVAL_DEBUG === '1') {
        let diagnostic = error instanceof Error ? error.message : code;
        for (const secret of [process.env.GEMINI_API_KEY, process.env.DATABASE_URL]) if (secret) diagnostic = diagnostic.replaceAll(secret, '[secret]');
        console.warn(JSON.stringify({ phase, code, diagnostic: redactIdentifiers(diagnostic).replace(/https?:\/\/[^\s"\\]+/g, '[url]').slice(0, 2500) }));
      }
      if (['HTTP_400', 'HTTP_401', 'HTTP_403'].includes(code)) fatal = code;
      const dailyQuota = dailyProviderQuota(error);
      if (dailyQuota) {
        fatal = 'AI_PROVIDER_DAILY_QUOTA';
        providerQuotaEvents.push({ ...dailyQuota, observedAt: new Date().toISOString() });
        snapshot();
      }
      if (code === 'HTTP_429' || code === 'HTTP_503' || code === 'AbortError') cooldownUntil = Math.max(cooldownUntil, Date.now() + 60000);
      throw error;
    }
  };
  const reserve = async (units: number) => {
    if (fatal) throw new Error(fatal);
    if (reserved + units > cap) { fatal = 'AI_EVALUATION_BUDGET_REACHED'; throw new Error(fatal); }
    reserved += units;
    snapshot();
  };
  const request = new EventEmitter() as Request;
  const response = new EventEmitter() as Response;
  const knowledge = new KnowledgeBaseRepository(), documents = new KnowledgeDocumentRepository();
  const retrieve = (query: string) => retrieveRagContext(query, {
    embed: text => generateEmbedding(text, 'query', 'none', { reserve, embed: async parameters => {
      const started = Date.now();
      try {
        const response = await models.embedContent(parameters);
        calls.push({ phase: 'embedding', elapsedMs: Date.now() - started, responded: true });
        return response;
      } catch (error) {
        calls.push({ phase: 'embedding', elapsedMs: Date.now() - started, responded: false, error: safeError(error) });
        throw error;
      }
    } }), searchKnowledge: knowledge.searchSimilar.bind(knowledge), searchDocuments: documents.searchSimilar.bind(documents),
  });
  let answer: Awaited<ReturnType<typeof answerFinancialPlan>> = null, failure: string | null = null;
  await new Promise<void>((done) => aiRequestScope(request, response, () => {
    answerFinancialPlan(message, facts, 'synthetic-owner', [], { generate, reserve, response: { generate, reserve, retrieve } })
      .then(value => { answer = value; }).catch(error => { failure = safeError(error); })
      .finally(() => { response.emit('finish'); done(); });
  }));
  const value = answer as Awaited<ReturnType<typeof answerFinancialPlan>>;
  const expectedMissing = executeFinancialPlan(row.missingInput, missingFacts());
  const mismatches = Object.entries(row.expected).filter(([key, expected]) => value?.result.values[key] !== expected)
    .map(([key, expected]) => ({ key, expected, actual: value?.result.values[key] ?? null, actualPresent: value?.result.values[key] !== undefined }));
  const missingDataHandled = !!value && (expectedMissing.operation === 'debt_totals'
    ? value.result.operation === 'debt_totals' && value.result.values.remaining === 0 && /unrecorded/i.test(value.content)
    : value.requiresClarification && value.result.values.affordable === undefined && value.result.values.completionDate === undefined);
  const explanationAccepted = !!value?.sources.length;
  if (calls.some(call => call.phase !== 'embedding' && call.responded)) unavailableScenarios = 0;
  else if (calls.some(call => call.phase !== 'embedding') && ++unavailableScenarios >= 3) fatal ||= 'AI_PROVIDER_UNAVAILABLE';
  return { mode, message, expectedOperation: row.completeInput.operation, operation: value?.result.operation ?? null,
    operationMatches: value?.result.operation === row.completeInput.operation,
    factCheck: !!value && !mismatches.length && !value.requiresClarification, mismatches,
    missingDataHandled, extractionAccepted, extractionRejection, explanationAccepted, providerAccepted: extractionAccepted || explanationAccepted,
    model: value?.model ?? null, values: value?.result.values ?? {}, missing: value?.result.missing ?? [],
    answer: value?.content ?? null, sources: value?.sources ?? [], retrieval: value?.retrieval ?? null, calls, failure, factsUnchanged: before === JSON.stringify(facts) };
}
async function coolDown() {
  if (Date.now() < cooldownUntil) console.log(JSON.stringify({ status: 'provider_cooldown', seconds: Math.ceil((cooldownUntil - Date.now()) / 1000) }));
  while (Date.now() < cooldownUntil && !fatal) await delay(Math.min(5000, cooldownUntil - Date.now()));
}
async function worker() {
  while (next < pending.length && !fatal) {
    const row = pending[next++];
    const previous = results.find(result => result.id === row.id);
    const run = async (mode: 'complete' | 'incomplete') => {
      const earlier = previous?.[mode];
      if (earlier && answered(earlier)) return earlier;
      await coolDown();
      const result = await evaluate(row, mode);
      if (earlier) availabilityRetries.push({ id: row.id, mode, at: new Date().toISOString(), previous: earlier });
      return result;
    };
    const complete = await run('complete');
    if (!fatal) await delay(scenarioDelay);
    const incomplete = await run('incomplete');
    const item = { id: row.id, question: row.question, complete, incomplete };
    if (previous) results[results.indexOf(previous)] = item; else results.push(item);
    const report = snapshot();
    console.log(JSON.stringify({ progress: `${results.length}/${count}`, id: row.id, facts: complete.factCheck,
      missing: incomplete.missingDataHandled, providerReplies: [...complete.calls, ...incomplete.calls].filter(call => call.phase !== 'embedding' && call.responded).length,
      actualTokens: report.usage.total, reservedTokenBound: reserved }));
    if (!fatal) await delay(scenarioDelay);
  }
}
try { await Promise.all(Array.from({ length: concurrency }, () => worker())); }
finally { const report = snapshot(true); console.log(JSON.stringify({ output, evaluated: report.evaluatedQuestions, summary: report.summary, usage: report.usage, stoppedReason: fatal })); await prisma.$disconnect(); }
process.exitCode = results.length === count && !fatal ? 0 : 1;
