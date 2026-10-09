import { prisma } from '@/lib/prisma';
import { completeFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan, type FinancialPlan } from '@/utils/financialPlanner';
import { explainFinancialPlan } from '@/services/planningResponse';
import { GoogleGenAI } from '@google/genai';
import { reserveAiTokens, type Generate } from '@/services/aiRuntime';
import { redactIdentifiers } from '@/utils/aiSafety';
import { retrieveRagContext } from '@/services/ragRetrieval';

// One opt-in, bounded provider check with synthetic data only. The usual
// configured model, token reservations, timeout and retry limits still apply.
if (process.env.AI_LIVE_CHECK !== '1') throw new Error('Set AI_LIVE_CHECK=1 to check the configured Gemini response using synthetic records.');
try {
  const facts = completeFacts();
  facts.breakdown.safeToSpend = 0;
  const plan: FinancialPlan = { operation: 'goal_timeline', language: 'en', target: 20000, saved: 0, contribution: 100, frequency: 'daily' };
  const calculated = executeFinancialPlan(plan, facts);
  const models = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }).models;
  const generate: Generate = async parameters => {
    try {
      const response = await models.generateContent(parameters);
      if (process.env.AI_LIVE_CHECK_DEBUG === '1') console.log(JSON.stringify({ syntheticResponse: response.text }));
      return response;
    }
    catch (error) {
      if (process.env.AI_LIVE_CHECK_DEBUG === '1') {
        // This probe uses synthetic records only. Never print a key, database
        // connection string, URL or the complete request/error object.
        const raw = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
        let safe = raw;
        for (const secret of [process.env.GEMINI_API_KEY, process.env.DATABASE_URL]) if (secret) safe = safe.replaceAll(secret, '[redacted]');
        console.log(JSON.stringify({ providerDiagnostic: redactIdentifiers(safe).replace(/https?:\/\/\S+/g, '[url]').slice(0, 600) }));
      }
      throw error;
    }
  };
  const response = await explainFinancialPlan('Explain how this savings timeline relates to money already saved and future contributions.', plan, calculated, facts, [], { generate, reserve: reserveAiTokens, retrieve: retrieveRagContext });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), synthetic: true, status: response.status,
    errorCode: response.errorCode, model: response.model, periods: calculated.values.periods,
    sources: response.sources, explanation: response.explanation, usage: response.usage,
    retrieval: { mode: response.retrieval.mode, errorCode: response.retrieval.errorCode,
      passages: response.retrieval.passages.map(({ id, source, version, distance }) => ({ id, source, version, distance })) } }, null, 2));
  if (response.status !== 'generated') process.exitCode = 1;
} finally { await prisma.$disconnect(); }
