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

test('the captured live paragraph denying an affordability assumption keeps its valid sources', async () => {
  const text = 'Calculating how long it takes to reach a financial goal depends on the target price, dedicated saved amount, and the specified contribution rate and frequency, without assuming future contributions are affordable.';
  const result = executeFinancialPlan(plan, completeFacts());
  const response = await explainFinancialPlan(message, plan, result, completeFacts(), [],
    provider(context => ({ explanation: text, sourceIds: [context.guidance[0].id] })));
  assert.equal(response.explanation, text);
  assert.equal(response.sources.length, 1);
});

test('a denied affordability assumption cannot hide a later positive claim or invented amount', async () => {
  const result = executeFinancialPlan(plan, completeFacts());
  for (const text of [
    'Without assuming future contributions are affordable, you can afford this purchase.',
    'Without assuming future contributions are affordable, your purchase is affordable.',
    'Without assuming future contributions are affordable, savings are guaranteed.',
    'Without assuming future contributions are affordable, you have ₱90000 available.',
  ]) {
    const response = await explainFinancialPlan(message, plan, result, completeFacts(), [],
      provider(context => ({ explanation: text, sourceIds: [context.guidance[0].id] })));
    assert.equal(response.explanation, '', text);
    assert.deepEqual(response.sources, []);
  }
});

test('generated guidance cannot demand a product variant or ask again for a supplied purchase price', async () => {
  const facts = completeFacts();
  const purchasePlan: FinancialPlan = { operation: 'goal_change', language: 'en', goalChangeKind: 'purchase', purchase: 10000 };
  const result = executeFinancialPlan(purchasePlan, facts);
  for (const text of ['Provide the exact product variant before calculating the effect on savings.',
    'The specific product model is required before proceeding.', 'Please specify the target price for this purchase.']) {
    const response = await explainFinancialPlan('How will buying a tablet affect my savings goals?', purchasePlan, result, facts, [],
      provider(data => ({ explanation: text, sourceIds: [data.guidance[0].id] })));
    assert.equal(response.status, 'rejected', text);
    assert.equal(response.explanation, '');
    assert.match(renderPlanningResponse(result, response.explanation), /Purchase cost: ₱10,000\.00/);
    assert.match(renderPlanningResponse(result, response.explanation), /Will you pay from available cash/);
    assert.doesNotMatch(renderPlanningResponse(result, response.explanation), /product variant|target price/);
  }
});

test('the captured live uncertainty explanation retains its validated citation', async () => {
  const question = 'Which expenses could I reduce to free up ₱2,000 monthly?';
  const cut: FinancialPlan = { operation: 'spending_cut', language: 'en', category: 'Food & Dining', percentCut: 100 };
  const facts = completeFacts(), result = executeFinancialPlan(cut, facts);
  for (const text of [
    'Estimating potential savings relies on specified percentage cuts and recorded past spending rather than guaranteed future expenses.',
    'Future contributions are not guaranteed and the savings timeline is conditional.',
    'There is no guarantee that future income matches recorded income.',
  ]) {
    const response = await explainFinancialPlan(question, cut, result, facts, [], provider(context => ({ explanation: text, sourceIds: [context.guidance[0].id] })));
    assert.equal(response.status, 'generated', text);
    assert.equal(response.explanation, text);
    assert.equal(response.sources.length, 1);
    assert.equal(result.values.saving, 2000);
  }
});

test('uncertainty wording cannot conceal positive guarantees or other unsafe claims', async () => {
  const facts = completeFacts(), result = executeFinancialPlan(plan, facts);
  for (const text of [
    'Future income is guaranteed.',
    'Future contributions are not guaranteed, but savings are guaranteed.',
    'Rather than guaranteed expenses, you can afford this purchase.',
    'There is no guarantee, but you have ₱90000 available.',
    'There is no guarantee, but buy stocks.',
  ]) {
    const response = await explainFinancialPlan(message, plan, result, facts, [], provider(context => ({ explanation: text, sourceIds: [context.guidance[0].id] })));
    assert.equal(response.status, 'rejected', text);
    assert.deepEqual(response.sources, []);
  }
});

test('the captured required-input explanation retains its citation without asserting affordability', async () => {
  const facts = completeFacts();
  const missingPlan = { ...plan, saved: undefined };
  const result = executeFinancialPlan(missingPlan, facts);
  const before = JSON.stringify(result);
  for (const text of [
    'Determining how long a goal will take relies on specific inputs including the target price, dedicated saved amount, and an affordable contribution rate with its frequency.',
    'A savings timeline requires an affordable contribution amount and its frequency.',
    'A debt timeline depends on affordable payments and interest terms.',
  ]) {
    const response = await explainFinancialPlan(message, missingPlan, result, facts, [], provider(context => ({ explanation: text, sourceIds: [context.guidance[0].id] })));
    assert.equal(response.status, 'generated', text);
    assert.equal(response.explanation, text);
    assert.equal(response.sources.length, 1);
    assert.equal(JSON.stringify(result), before);
    assert.match(renderPlanningResponse(result, response.explanation), /How much is already saved specifically for this target\?$/);
  }
});

test('prerequisite wording cannot conceal personal affordability claims or unsafe advice', async () => {
  const facts = completeFacts(), result = executeFinancialPlan(plan, facts);
  for (const text of [
    'Your payment is affordable.',
    'This is an affordable contribution.',
    'A timeline requires inputs, but your plan is affordable.',
    'A timeline requires a contribution that is affordable for you.',
    'A timeline needs affordable contributions; your purchase is affordable.',
    'A timeline requires affordable contributions because your payments seem affordable.',
    'Your plan requires an affordable contribution of ₱90000.',
    'A timeline requires affordable contributions and you can afford this purchase.',
    'A timeline requires affordable contributions and buy stocks.',
    'A timeline requires affordable contributions and savings are guaranteed.',
  ]) {
    const response = await explainFinancialPlan(message, plan, result, facts, [], provider(context => ({ explanation: text, sourceIds: [context.guidance[0].id] })));
    assert.equal(response.status, 'rejected', text);
    assert.deepEqual(response.sources, []);
  }
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
