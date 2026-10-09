import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { GenerateContentResponse } from '@google/genai';
import dataset from '@/evaluation/aiQuestions.v1.json';
import { completeFacts, missingFacts } from '@/evaluation/planningFixtures';
import { executeFinancialPlan, planSchema, readPlanningContext } from './financialPlanner';
import { answerFinancialPlan, localFinancialPlan, verifyExtractedPlan } from '@/services/financialPlanner';
import { cashWindow, cents, contributionDates, debtPayoff, goalTimeline } from './planningCalculators';
import { chunkGuidance, retrieveGuidance } from './assistantKnowledge';
import { generateBounded, boundedHistory, transientStatus, retryDelay } from '@/services/aiRuntime';

test('question bank has all 150 original IDs and an integrity digest', () => {
  assert.equal(dataset.questions.length, 150);
  assert.deepEqual(dataset.questions.map(row => row.id), Array.from({ length: 150 }, (_, index) => index + 1));
  const questions = dataset.questions.map(({ id, question }) => ({ id, question }));
  assert.equal(createHash('sha256').update(JSON.stringify(questions)).digest('hex'), dataset.sourceSha256);
});
for (const row of dataset.questions) {
  test(`Q${row.id} complete scenario: ${row.question}`, () => {
    const facts = completeFacts(), before = JSON.stringify(facts);
    const result = executeFinancialPlan(row.completeInput, facts);
    assert.deepEqual(result.missing, [], result.content);
    for (const [key, value] of Object.entries(row.expected)) assert.equal(result.values[key], value, `${key}: ${JSON.stringify(result.values)}`);
    for (const tool of row.tools) assert.ok(result.tools.includes(tool), `missing tool ${tool}`);
    assert.equal(JSON.stringify(facts), before, 'Questions must not mutate data');
    assert.ok(result.assumptions.length > 0);
  });
  test(`Q${row.id} incomplete records: ${row.question}`, () => {
    const facts = missingFacts(), before = JSON.stringify(facts);
    const result = executeFinancialPlan(row.missingInput, facts);
    if (row.completeInput.operation === 'debt_totals') {
      assert.equal(result.values.remaining, 0); assert.match(result.content, /unrecorded/i);
    } else assert.ok(result.missing.length > 0, `Must ask for missing data: ${result.content}`);
    assert.equal(result.values.affordable, undefined);
    assert.equal(result.values.completionDate, undefined);
    assert.equal(JSON.stringify(facts), before);
  });
  test(`Q${row.id} read-only orchestration with mocked extraction`, async () => {
    const response = await answerFinancialPlan(row.question, missingFacts(), 'owner-a', [], {
      generate: async () => ({ text: JSON.stringify({ operation: row.completeInput.operation, language: 'en' }) }) as GenerateContentResponse,
      reserve: async () => {},
    });
    assert.ok(response);
    assert.equal(response.result.operation, row.completeInput.operation);
    assert.equal(response.context.owner, 'owner-a');
  });
}

test('illustrative target is 60000 remaining and 15 contributions, without a fabricated date', () => {
  assert.deepEqual(goalTimeline(80000, 20000, 4000), { remaining: 60000, periods: 15, completionDate: null });
  assert.equal(goalTimeline(80000, 20000, 0).periods, null);
  assert.throws(() => cents(0.001));
  assert.equal(cents(0.29), 29);
});
test('monthly anchors, actual weekdays, and explicit paydays preserve calendar behavior', () => {
  assert.deepEqual(contributionDates({ frequency: 'monthly', first: '2028-01-31' }, '2028-03-31'), ['2028-01-31', '2028-02-29', '2028-03-31']);
  assert.equal(goalTimeline(300, 0, 100, { frequency: 'payday', first: '2026-10-15', paydays: ['2026-10-15', '2026-10-30'] }).completionDate, null);
  assert.equal(goalTimeline(300, 0, 100, { frequency: 'weekly', first: '2026-10-09' }).completionDate, '2026-10-23');
  assert.equal(goalTimeline(200, 0, 100, { frequency: 'monthly', first: '2028-01-31' }, 1).completionDate, '2028-03-31');
});
test('emergency horizons count future bill occurrences and paid subscriptions remain recurring costs', () => {
  const facts = completeFacts();
  assert.equal(executeFinancialPlan({ operation: 'emergency_cover', emergencyMonths: 3 }, facts).values.target, 18700);
  facts.planning!.recurringObligations = [{ name: 'Paid subscription', amount: 199, frequency: 'MONTHLY' }];
  assert.equal(executeFinancialPlan({ operation: 'bill_cost', billNames: ['Paid subscription'] }, facts).values.yearlyEquivalent, 2388);
  facts.accounts[0].balance = -100;
  const overdraft = executeFinancialPlan({ operation: 'afford_purchase', purchase: 100 }, facts);
  assert.ok(overdraft.missing.includes('overdraft_terms')); assert.equal(overdraft.values.affordable, undefined);
});
test('a one-time bonus does not silently become a recurring saving contribution', () => {
  const plan = localFinancialPlan('If I receive a PHP 5000 bonus, how much closer will I be to my Laptop goal?', completeFacts())!;
  const result = executeFinancialPlan(plan, completeFacts());
  assert.equal(plan.bonus, 5000); assert.equal(plan.delta, undefined);
  assert.equal(result.values.contribution, 4000); assert.equal(result.values.periods, 9);
});
test('shared surplus, negative cash and protected savings do not get double allocated', () => {
  const facts = completeFacts();
  const split = executeFinancialPlan({ operation: 'goal_split', goalNames: ['Laptop', 'Emergency'], contribution: 5000, periods: 12 }, facts);
  assert.equal(split.values.Laptop, 5000); assert.equal(split.values.Emergency, 0); assert.equal(split.values.canFinishAll, false);
  assert.equal(cashWindow({ accessible: 100, protectedCash: 50, bills: 100, debts: 0, essentialDaily: 10, days: 5 }).shortfall, 100);
  facts.goals[0].saved = 45000;
  assert.equal(executeFinancialPlan({ operation: 'cash_available' }, facts).values.available, 36800, 'Saved goal funds already left wallet');
});
test('loan calculations distinguish flat/reducing and reject payments below interest and fees', () => {
  assert.equal(debtPayoff({ principal: 12000, payment: 1500, interestType: 'interest_free' }).periods, 8);
  const flat = debtPayoff({ principal: 12000, payment: 1500, interestType: 'flat', rateBpsPerPeriod: 100, feePerPeriod: 30 });
  const reducing = debtPayoff({ principal: 12000, payment: 1500, interestType: 'reducing', rateBpsPerPeriod: 100, feePerPeriod: 30 });
  assert.ok(flat.total! > reducing.total!);
  assert.equal(debtPayoff({ principal: 12000, payment: 100, interestType: 'reducing', rateBpsPerPeriod: 100 }).doesNotAmortize, true);
  assert.ok(executeFinancialPlan({ operation: 'debt_payoff', payment: 1500 }, completeFacts()).missing.includes('interest_terms'));
});
test('validated scenario expires, rejects another owner and refreshes balances', () => {
  const now = Date.now(), context = { kind: 'FINANCIAL_PLAN_V1', owner: 'owner-a', updatedAt: new Date(now).toISOString(), plan: { operation: 'goal_timeline', goalNames: ['Laptop'] } };
  assert.ok(readPlanningContext(context, 'owner-a', now));
  assert.equal(readPlanningContext(context, 'owner-b', now), null);
  assert.equal(readPlanningContext(context, 'owner-a', now + 31 * 60000), null);
  const facts = completeFacts();
  assert.equal(localFinancialPlan('What if I save PHP 500 more monthly?', facts, readPlanningContext(context, 'owner-a'))?.operation, 'goal_change');
  facts.accounts[0].balance = 0;
  assert.equal(executeFinancialPlan({ operation: 'cash_available' }, facts).values.available, 16800);
});
test('English, Tagalog and Cebuano paraphrases enter read-only planning', () => {
  for (const [message, lang] of [['Can I afford a phone?', 'en'], ['Kaya ko bang bumili ng phone?', 'tl'], ['Makapalit ba ko og phone sa akong kwarta?', 'ceb']]) {
    const plan = localFinancialPlan(message, completeFacts()); assert.ok(plan); assert.equal(plan.language, lang);
  }
  assert.equal(localFinancialPlan('Transfer 100 from Cash to Bank today', completeFacts()), null);
});
test('short clarification replies retain the price and fill savings, contribution and payday fields', () => {
  const facts = missingFacts(), owner = 'owner-a';
  let plan = localFinancialPlan('How long will it take to save for a phone?', facts)!;
  const context = () => ({ kind: 'FINANCIAL_PLAN_V1' as const, owner, updatedAt: new Date().toISOString(), plan });
  plan = localFinancialPlan('PHP 80000', facts, context())!;
  assert.equal(plan.target, 80000);
  plan = localFinancialPlan('PHP 20000', facts, context())!;
  assert.equal(plan.target, 80000); assert.equal(plan.saved, 20000);
  plan = localFinancialPlan('4000', facts, context())!;
  assert.equal(executeFinancialPlan(plan, facts).values.periods, 15);
  plan = { operation: 'cash_available', language: 'en' };
  const complete = completeFacts(); complete.planning!.nextPayday = null;
  plan = localFinancialPlan('2026-10-15', complete, context())!;
  assert.equal(plan.nextPayday, '2026-10-15');
});
test('malicious generated ownership, prices, dates and writes fail schema/provenance validation', () => {
  const plan = { operation: 'goal_timeline' as const, language: 'en' as const };
  for (const extra of [{ userId: 'victim' }, { operation: 'TRANSFER' }, { target: 99999 }, { until: '2030-01-01' }]) {
    assert.throws(() => verifyExtractedPlan({ ...plan, ...extra }, 'How long until I can buy an iPhone 18?', plan));
  }
  assert.equal(planSchema.safeParse({ ...plan, contribution: -1 }).success, false);
});
test('approved passage retrieval has bounded overlap/context and no unrelated evidence', () => {
  const chunks = chunkGuidance('test', 'x'.repeat(5000), 600, 500);
  assert.ok(chunks.every(row => row.text.length <= 600));
  assert.equal(retrieveGuidance('volcano spectroscopy neutron').length, 0);
  const passages = retrieveGuidance('monthly savings goal contributions');
  assert.ok(passages.length > 0); assert.ok(passages.reduce((sum, row) => sum + row.text.length, 0) <= 1800);
});
test('history and aggregate provider payload are bounded without sending huge requests', async () => {
  assert.equal(boundedHistory(Array.from({ length: 20 }, () => ({ question: 'x'.repeat(4000), answer: 'y'.repeat(4000) }))).length, 6);
  assert.ok(boundedHistory([{ question: 'x'.repeat(4000), answer: 'y'.repeat(4000) }]).every(row => row.content.length <= 1500));
  let calls = 0;
  await assert.rejects(generateBounded({ contents: 'x'.repeat(50000) }, { generate: async () => { calls++; return {} as GenerateContentResponse; }, reserve: async () => {} }), /CONTEXT_TOO_LARGE/);
  assert.equal(calls, 0);
});
test('provider retries only transient failures and respects cancellation/global budget failure', async () => {
  assert.equal(transientStatus({ status: 401 }), null); assert.equal(transientStatus({ status: 429 }), 429);
  assert.equal(retryDelay({ headers: { 'retry-after': '2' } }, 0, 0), 2000);
  let calls = 0, reservations = 0;
  const response = await generateBounded({ contents: 'test' }, { reserve: async () => { reservations++; }, generate: async () => { if (calls++ === 0) throw { status: 503 }; return { text: 'ok' } as GenerateContentResponse; } });
  assert.equal(response.text, 'ok'); assert.equal(calls, 2); assert.equal(reservations, 2);
  for (const status of [400, 401, 403]) {
    calls = 0;
    await assert.rejects(generateBounded({ contents: 'test' }, { reserve: async () => {}, generate: async () => { calls++; throw { status }; } }));
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(generateBounded({ contents: 'test' }, { reserve: async () => { throw new Error('AI_GLOBAL_BUDGET_REACHED'); }, generate: async () => { calls++; return {} as GenerateContentResponse; } }), /GLOBAL_BUDGET/);
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(generateBounded({ contents: 'test' }, { signal: controller.signal, reserve: async () => {}, generate: async () => { calls++; return {} as GenerateContentResponse; } }), /DEADLINE/);
  assert.equal(calls, 0);
});
test('provider/embedding outage still returns a deterministic result or honest clarification', async () => {
  const response = await answerFinancialPlan('Can I afford new shoes worth PHP 4000?', completeFacts(), 'owner-a', [], {
    reserve: async () => {}, generate: async () => { throw { status: 403 }; },
  });
  assert.equal(response?.result.values.afterPurchase, 32800); assert.equal(response?.model, 'local-financial-planner-v1');
  const unknown = await answerFinancialPlan('How long until I can buy the latest iPhone 18 Pro Max?', missingFacts(), 'owner-a', [], { reserve: async () => {}, generate: async () => { throw { status: 403 }; } });
  assert.ok(unknown?.requiresClarification); assert.ok(unknown?.result.missing.includes('target_price'));
});
test('attempt timeout actually aborts the provider request', async () => {
  const old = process.env.AI_ATTEMPT_TIMEOUT_MS;
  process.env.AI_ATTEMPT_TIMEOUT_MS = '20';
  let aborted = false;
  try {
    await assert.rejects(generateBounded({ contents: 'test' }, {
      reserve: async () => {},
      generate: async parameters => new Promise((_resolve, reject) => {
        const signal = parameters.config!.abortSignal!;
        assert.equal(parameters.config!.httpOptions!.timeout, 10000, 'The provider service deadline must meet its minimum even for a shorter client timeout');
        const keepAlive = setTimeout(() => reject(new Error('Provider did not receive abort')), 1000);
        signal.addEventListener('abort', () => { aborted = true; clearTimeout(keepAlive); reject(new Error('PROVIDER_ABORTED')); }, { once: true });
      }),
    }), /PROVIDER_ABORTED/);
    assert.equal(aborted, true);
  } finally { if (old == null) delete process.env.AI_ATTEMPT_TIMEOUT_MS; else process.env.AI_ATTEMPT_TIMEOUT_MS = old; }
});
