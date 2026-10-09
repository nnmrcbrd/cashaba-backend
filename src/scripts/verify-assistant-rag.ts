import 'dotenv/config';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma, qualifiedTable } from '@/lib/prisma';
import bank from '@/evaluation/aiQuestions.v1.json';
import { retrieveRagContext } from '@/services/ragRetrieval';
import { generateEmbedding } from '@/services/embedding';
import { KnowledgeBaseRepository, KnowledgeDocumentRepository } from '@/repositories/knowledge.repository';
import { EMBEDDING_VERSION, EMBEDDING_DIMENSIONS, contentHash } from '@/utils/rag';
import { PLANNING_OPERATIONS } from '@/utils/planningIntent';

// Live embedding + real database retrieval only. No generation calls, private
// financial tables, authentication bypass or ledger writes. Explicit opt-in.
if (process.env.AI_RAG_EVAL !== '1' || !process.env.GEMINI_API_KEY) throw new Error('Set AI_RAG_EVAL=1 and configure GEMINI_API_KEY');
const supplementalOnly = process.env.AI_RAG_EVAL_SUPPLEMENTAL_ONLY === '1';
const count = supplementalOnly ? 0 : Number(process.env.AI_RAG_EVAL_QUESTIONS ?? 150);
const cap = Number(process.env.AI_RAG_EVAL_TOKEN_CAP ?? 250000);
if (!Number.isInteger(count) || count < (supplementalOnly ? 0 : 1) || count > 150 || !Number.isSafeInteger(cap) || cap < 1 || cap > 1000000) throw new Error('Invalid retrieval evaluation bounds');
const output = resolve(process.env.AI_RAG_EVAL_OUTPUT ?? 'ai-rag-evaluation.json');
mkdirSync(dirname(output), { recursive: true });
const startedAt = new Date().toISOString();
const implementationDigest = contentHash(['src/services/ragRetrieval.ts', 'src/services/embedding.ts',
  'src/repositories/knowledge.repository.ts', 'src/utils/rag.ts', 'src/scripts/verify-assistant-rag.ts'].map(path => readFileSync(path, 'utf8')).join('\n'));
const knowledge = new KnowledgeBaseRepository(), documents = new KnowledgeDocumentRepository();
type Entry = { id: string; question: string; category: string; contentHash: string };
type Check = { id: string; query: string; expected: string; mode: string; passed: boolean; exactQuestionRetrieved?: boolean;
  errorCode?: string; elapsedMs: number; sources: Array<{ id: string; source: string; version: string; distance: number }> };
const checks: Check[] = [];
let reservedTokenBound = 0, stoppedReason: string | null = null, databaseEvidence: unknown;
const reserve = async (units: number) => {
  if (reservedTokenBound + units > cap) throw new Error('AI_EVALUATION_BUDGET_REACHED');
  reservedTokenBound += units;
};
const additional = [
  { query: 'Pila ka bulan ko magtigom kung 1000 kada bulan?', expected: 'Savings timeline', categories: ['goal_timeline', 'goal_contribution'] },
  { query: 'How many months to save for a phone if I save 1000 every month?', expected: 'Savings timeline', categories: ['goal_timeline', 'goal_contribution'] },
  { query: 'How much can I spend after paying all my upcoming bills?', expected: 'Maximum spendable cash', categories: ['cash_available'] },
  { query: 'Can my wallet cash pay for a new laptop while protecting rent money?', expected: 'Specific purchase affordability', categories: ['afford_purchase'] },
  { query: 'How do I add a wallet in Casha-Ba?', expected: 'Account guidance', sources: ['Casha-Ba: accounts', 'Casha-Ba: help'] },
  { query: 'Unsaon nako pagdugang og wallet sa Casha-Ba?', expected: 'Account guidance in Cebuano', sources: ['Casha-Ba: accounts', 'Casha-Ba: help'] },
  { query: 'Where can I change my monthly spending limit?', expected: 'Budget guidance', sources: ['Casha-Ba: budget'] },
  { query: 'How do I correct an expense logged in the wrong category?', expected: 'Transaction guidance', sources: ['Casha-Ba: transactions', 'Casha-Ba: corrections'] },
  { query: 'Who won the football World Cup?', expected: 'No relevant financial guidance' },
  { query: 'Write a spaghetti carbonara recipe', expected: 'No relevant financial guidance' },
  { query: 'Explain photosynthesis and chloroplasts', expected: 'No relevant financial guidance' },
  { query: 'Give me travel directions to the Eiffel Tower', expected: 'No relevant financial guidance' },
];
for (const row of additional) if ('categories' in row && row.categories?.some(category => !(category in PLANNING_OPERATIONS))) throw new Error('Unknown labeled planning category');
function snapshot(finished = false) {
  const original = checks.filter(row => row.id.startsWith('question:'));
  const supplemental = checks.filter(row => row.id.startsWith('paraphrase:'));
  const report = { startedAt, updatedAt: new Date().toISOString(), finished,
    completed: finished && !stoppedReason && original.length === count && supplemental.length === additional.length,
    implementationDigest, embeddingVersion: EMBEDDING_VERSION, dimensions: EMBEDDING_DIMENSIONS,
    maxDistance: Number(process.env.AI_RAG_MAX_DISTANCE ?? 0.4), requestedQuestions: count, supplementalOnly,
    tokenReservationCap: cap, reservedTokenBound, databaseEvidence, stoppedReason,
    summary: { originalQuestionsEvaluated: original.length, originalRelevancePassed: original.filter(row => row.passed).length,
      originalExactQuestionRetrieved: original.filter(row => row.exactQuestionRetrieved).length,
      supplementalEvaluated: supplemental.length, supplementalPassed: supplemental.filter(row => row.passed).length,
      providerErrors: checks.filter(row => row.mode === 'unavailable').length },
    methodology: 'Real Gemini query embeddings and PostgreSQL cosine searches. Original relevance requires the expected planning category or exact question in the top-three passages. Paraphrases use labeled topics, unrelated queries require no passages. No live generated answer or actual-account comparison is claimed.', checks };
  writeFileSync(output + '.tmp', JSON.stringify(report, null, 2)); renameSync(output + '.tmp', output);
  return report;
}
try {
  const entries = await prisma.$queryRawUnsafe<Entry[]>(`SELECT "id","question","category","contentHash" FROM ${qualifiedTable('KnowledgeBase')} WHERE "isActive"`);
  const byId = new Map(entries.map(row => [`kb:${row.id}`, row]));
  const counts = await prisma.$queryRawUnsafe(`SELECT 'questions' AS corpus, COUNT(*)::integer AS total,
    COUNT(*) FILTER (WHERE "isActive" AND "embedding" IS NOT NULL AND "embeddingVersion"=$1)::integer AS compatible,
    MIN(vector_dims("embedding")) AS min_dimensions, MAX(vector_dims("embedding")) AS max_dimensions FROM ${qualifiedTable('KnowledgeBase')}
    UNION ALL SELECT 'documents', COUNT(*)::integer,
    COUNT(*) FILTER (WHERE "isActive" AND "embedding" IS NOT NULL AND "embeddingVersion"=$1)::integer,
    MIN(vector_dims("embedding")), MAX(vector_dims("embedding")) FROM ${qualifiedTable('KnowledgeDocument')}`, EMBEDDING_VERSION);
  const extension = await prisma.$queryRawUnsafe(`SELECT extversion FROM pg_extension WHERE extname='vector'`);
  const indexes = await prisma.$queryRawUnsafe(`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('KnowledgeBase','KnowledgeDocument') AND indexdef LIKE '%hnsw%'`);
  const contextColumn = await prisma.$queryRawUnsafe(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='AiSession' AND column_name='context_metadata'`);
  databaseEvidence = { counts, extension, indexes, contextColumn };
  const evaluate = async (id: string, query: string, expected: string, matches: (sources: Check['sources']) => boolean, originalQuestion?: string) => {
    const started = Date.now();
    const result = await retrieveRagContext(query, {
      embed: text => generateEmbedding(text, 'query', 'none', { reserve }),
      searchKnowledge: knowledge.searchSimilar.bind(knowledge), searchDocuments: documents.searchSimilar.bind(documents),
    });
    const sources = result.passages.map(({ id, source, version, distance }) => ({ id, source, version, distance }));
    const exactQuestionRetrieved = originalQuestion ? sources.some(source => byId.get(source.id)?.question === originalQuestion) : undefined;
    const check = { id, query, expected, mode: result.mode, passed: result.mode !== 'unavailable' && matches(sources),
      exactQuestionRetrieved, errorCode: result.errorCode, elapsedMs: Date.now() - started, sources };
    checks.push(check); snapshot();
    console.log(JSON.stringify({ id, passed: check.passed, mode: check.mode, exactQuestionRetrieved, elapsedMs: check.elapsedMs }));
    if (result.mode === 'unavailable') throw new Error(result.errorCode || 'AI_RETRIEVAL_UNAVAILABLE');
    await delay(750);
  };
  for (const row of bank.questions.slice(0, count)) {
    await evaluate(`question:${row.id}`, row.question, row.completeInput.operation,
      sources => sources.some(source => byId.get(source.id)?.category === row.completeInput.operation || byId.get(source.id)?.question === row.question), row.question);
  }
  for (const [i, row] of additional.entries()) {
    await evaluate(`paraphrase:${i + 1}`, row.query, row.expected, sources => {
      if ('categories' in row) return sources.some(source => row.categories?.includes(byId.get(source.id)?.category || ''));
      if ('sources' in row) return sources.some(source => row.sources?.includes(source.source));
      return sources.length === 0;
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  stoppedReason = /^AI_[A-Z_]+$/.test(message) || /^HTTP_\d{3}$/.test(message) ? message : 'AI_RAG_EVALUATION_FAILED';
} finally {
  const report = snapshot(true); console.log(JSON.stringify({ output, summary: report.summary, completed: report.completed, stoppedReason }));
  await prisma.$disconnect();
  process.exitCode = report.completed && checks.every(row => row.passed) ? 0 : 1;
}
