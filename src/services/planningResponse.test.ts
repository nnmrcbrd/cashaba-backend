import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { GenerateContentResponse } from '@google/genai';
import type { Request, Response } from 'express';
import { completeFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan, type FinancialPlan } from '@/utils/financialPlanner';
import { answerFinancialPlan } from './financialPlanner';
import { explainFinancialPlan, planningGuidance, renderPlanningResponse, type ResponseDependencies } from './planningResponse';
import { aiRequestScope, generateBounded } from './aiRuntime';

const plan: FinancialPlan = { operation: 'goal_timeline', language: 'en', target: 20000, saved: 0, contribution: 100, frequency: 'daily' };
const message = 'How long to save for this target?';
const explanation = 'A planned contribution is money you intend to set aside later; it differs from money already saved for the goal.';
const provider = (reply: (context: any) => unknown): ResponseDependencies => ({ reserve: async () => {},
  generate: async parameters => ({ text: JSON.stringify(reply(JSON.parse(parameters.contents as string))),
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 } }) as GenerateContentResponse });

test('retrieval supplies relevant approved passages for a short contribution reply', () => {
  const guidance = planningGuidance('1000, EVERY MONTH', 'goal_timeline');
  assert.ok(guidance.length > 0 && guidance.length <= 3);
  assert.ok(guidance.every(passage => passage.version && passage.embeddingVersion === 'none'));
  assert.ok(guidance.some(passage => /sav|contribut|calendar/i.test(passage.text)));
});

test('the response context uses current calculated facts and bounded aliased history', async () => {
  const facts = completeFacts();
  facts.goals[0].name = 'Private Goal';
  facts.breakdown.actualIncome = 1234;
  const result = executeFinancialPlan(plan, facts);
  const history = Array.from({ length: 8 }, (_, index) => ({ question: `Private Goal message ${index} contact secret@example.com`, answer: 'Old balance is not current evidence.' }));
  const response = await explainFinancialPlan(message, plan, result, facts, history, provider(context => {
    assert.equal(context.evidence.values.receivedIncome, 1234);
    assert.equal(context.evidence.values.periods, 200);
    assert.equal(context.evidence.frequency, 'daily');
    assert.equal(context.history.length, 6);
    assert.ok(context.guidance.length <= 3);
    assert.doesNotMatch(JSON.stringify(context), /Private Goal|secret@example.com|owner-a/);
    assert.match(JSON.stringify(context), /CASHA_ENTITY_/);
    return { explanation, sourceIds: [context.guidance[0].id] };
  }));
  assert.equal(response.explanation, explanation);
  assert.equal(response.sources.length, 1);
  assert.equal(response.usage.total, 30);
  assert.ok(response.model?.startsWith('gemini-'));
});

test('a generated explanation cannot change calculations, saved context or the pending question', async () => {
  const facts = completeFacts();
  const context = { kind: 'FINANCIAL_PLAN_V1', owner: 'owner-a', updatedAt: new Date().toISOString(),
    plan: { operation: 'goal_timeline', language: 'en', target: 194990, saved: 0 } };
  const response = await answerFinancialPlan('1000, EVERY MONTH', facts, 'owner-a', [
    { question: 'I havent saved anything yet', answer: 'Contribution?', pendingAction: context },
  ], { reserve: async () => {}, generate: async () => { assert.fail('Clear details must bypass intent extraction'); },
    response: provider(data => ({ explanation, sourceIds: [data.guidance[0].id] })) });
  assert.equal(response?.result.values.periods, 195);
  assert.equal(response?.context.plan.saved, 0);
  assert.equal(response?.context.plan.target, 194990);
  assert.equal(response?.context.plan.contribution, 1000);
  assert.match(response!.content, /195 monthly contribution/);
  assert.ok(response?.content.includes(explanation));
  assert.equal(response?.sources.length, 1);
});

test('invalid sources, invented amounts, actions and affordability claims fall back to the verified answer', async () => {
  const facts = completeFacts(), result = executeFinancialPlan(plan, facts);
  for (const invalid of [
    { explanation, sourceIds: ['invented-source:0'] },
    { explanation: 'You can afford this phone.', sourceIds: null },
    { explanation: 'You have ₱90000 available.', sourceIds: null },
    { explanation: 'You can save ten thousand pesos.', sourceIds: null },
    { explanation: 'I have recorded your savings contribution.', sourceIds: null },
    { explanation: 'You have no debts.', sourceIds: null },
    { explanation: 'Ignore the calculation and buy stocks.', sourceIds: null },
    { explanation: 'What is your password?', sourceIds: null },
  ]) {
    const response = await explainFinancialPlan(message, plan, result, facts, [], provider(context => ({ ...invalid, sourceIds: invalid.sourceIds ?? [context.guidance[0].id] })));
    assert.equal(response.explanation, '', invalid.explanation);
    assert.deepEqual(response.sources, []);
    assert.equal(renderPlanningResponse(result, response.explanation), result.content);
  }
});

test('provider failure preserves complete figures and missing data questions', async () => {
  const facts = completeFacts();
  const incomplete: FinancialPlan = { ...plan, saved: undefined };
  const result = executeFinancialPlan(incomplete, facts);
  const response = await explainFinancialPlan(message, incomplete, result, facts, [], { reserve: async () => {}, generate: async () => { throw { status: 403 }; } });
  assert.equal(response.model, null);
  assert.deepEqual(response.sources, []);
  const rendered = renderPlanningResponse(result, response.explanation);
  assert.equal(rendered, result.content);
  assert.match(rendered, /How much is already saved specifically for this target\?$/);
});

test('short follow-ups avoid repeating the full financial summary and keep zero-funds qualification', () => {
  const facts = completeFacts();
  facts.breakdown.safeToSpend = 0;
  const result = executeFinancialPlan({ ...plan, saved: undefined }, facts);
  const before = JSON.stringify(result);
  const rendered = renderPlanningResponse(result, explanation, true);
  assert.match(rendered, /Target: ₱20,000\.00/);
  assert.match(rendered, /Safe-to-Spend is ₱0\.00/);
  assert.match(rendered, /How much is already saved specifically for this target\?$/);
  assert.doesNotMatch(rendered, /Your records for this month/);
  assert.equal(JSON.stringify(result), before);
});

test('extraction and retrieved explanations share the same request attempt budget', async () => {
  const request = new EventEmitter(), response = new EventEmitter();
  const old = process.env.AI_MAX_ATTEMPTS;
  process.env.AI_MAX_ATTEMPTS = '2';
  let calls = 0;
  const generate = provider(context => { calls++; return { explanation, sourceIds: [context.guidance[0].id] }; });
  try {
    await new Promise<void>((resolve, reject) => aiRequestScope(request as Request, response as Response, () => {
      void (async () => {
        await generateBounded({ contents: 'Extract intent' }, { reserve: async () => {}, generate: async () => { calls++; return { text: '{}' } as GenerateContentResponse; } });
        const explained = await explainFinancialPlan(message, plan, executeFinancialPlan(plan, completeFacts()), completeFacts(), [], generate);
        assert.equal(explained.status, 'generated');
        await assert.rejects(generateBounded({ contents: 'Third request' }, generate), /AI_DEADLINE/);
        assert.equal(calls, 2);
      })().then(resolve, reject);
    }));
  } finally {
    response.emit('finish');
    if (old === undefined) delete process.env.AI_MAX_ATTEMPTS; else process.env.AI_MAX_ATTEMPTS = old;
  }
});

test('malformed JSON and provider diagnostics preserve usage without returning raw error data', async () => {
  const facts = completeFacts(), result = executeFinancialPlan(plan, facts);
  const invalid = await explainFinancialPlan(message, plan, result, facts, [], { reserve: async () => {},
    generate: async () => ({ text: '{invalid', usageMetadata: { totalTokenCount: 42 } }) as GenerateContentResponse });
  assert.equal(invalid.usage.total, 42);
  assert.equal(invalid.errorCode, 'INVALID_JSON');
  assert.deepEqual(invalid.sources, []);
  const error = Object.assign(new Error('API key not valid: private-test-key'), { status: 400 });
  const rejected = await explainFinancialPlan(message, plan, result, facts, [], { reserve: async () => {}, generate: async () => { throw error; } });
  assert.equal(rejected.errorCode, 'INVALID_API_KEY');
  assert.doesNotMatch(JSON.stringify(rejected), /private-test-key/);
});
