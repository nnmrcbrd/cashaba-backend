import test from 'node:test';
import assert from 'node:assert/strict';
import dataset from '@/evaluation/aiQuestions.v1.json';
import { OPERATIONS, planSchema } from './financialPlanner';
import { planningProviderSchema, unwrapPlanningParameters } from './planningProviderSchema';
import { answerFinancialPlan } from '@/services/financialPlanner';
import { completeFacts } from '@/evaluation/planningFixtures';
import type { GenerateContentResponse } from '@google/genai';

test('simple provider envelope round-trips every supplied field in all 150 planning scenarios', () => {
  for (const row of dataset.questions) {
    const plan = planSchema.parse(row.completeInput);
    const wire = { operation: plan.operation, language: plan.language, parameters: Object.entries(plan)
      .filter(([key]) => !['operation', 'language'].includes(key)).map(([field, value]) => ({ field, valueJson: JSON.stringify(value) })) };
    assert.deepEqual(planSchema.parse(unwrapPlanningParameters(wire)), plan, `Q${row.id} lost a supplied field`);
  }
});
test('a simple extraction envelope keeps all operation choices and strict server validation', () => {
  const schema = planningProviderSchema();
  const operation = schema.properties?.operation;
  assert.ok(operation && typeof operation === 'object');
  assert.deepEqual(operation.enum, [...OPERATIONS]);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['operation', 'language', 'parameters']);
  assert.equal(schema.additionalProperties, false);
  assert.throws(() => planSchema.parse({ operation: 'goal_timeline', target: 0.001 }));
  assert.throws(() => planSchema.parse({ operation: 'goal_timeline', schedule: { frequency: 'daily', first: '2026-02-31' } }));
  assert.throws(() => planSchema.parse({ operation: 'goal_timeline', arbitraryField: 'untrusted' }));
});
test('provider parameters reject duplicate, unknown and invalid JSON fields', () => {
  const wrap = (parameters: unknown) => ({ operation: 'goal_timeline', language: 'en', parameters });
  assert.throws(() => unwrapPlanningParameters(wrap([{ field: 'target', valueJson: '1' }, { field: 'target', valueJson: '2' }])));
  assert.throws(() => unwrapPlanningParameters(wrap([{ field: 'owner', valueJson: '"someone-else"' }])));
  assert.throws(() => unwrapPlanningParameters(wrap([{ field: 'saved', valueJson: 'not JSON' }])));
  assert.throws(() => planSchema.parse(unwrapPlanningParameters(wrap([{ field: 'target', valueJson: '0.001' }]))));
});
test('live-format parameter output reaches the verified calculator through orchestration', async () => {
  const response = await answerFinancialPlan('Target PHP 80000, saved PHP 20000, saving PHP 4000 monthly. How long?', completeFacts(), 'synthetic-owner', [], {
    generate: async parameters => {
      assert.deepEqual(Object.keys((parameters.config?.responseJsonSchema as { properties: object }).properties), ['operation', 'language', 'parameters']);
      return { text: JSON.stringify({ operation: 'goal_timeline', language: 'en', parameters: [
        { field: 'target', valueJson: '80000' }, { field: 'saved', valueJson: '20000' },
        { field: 'contribution', valueJson: '4000' }, { field: 'frequency', valueJson: '"monthly"' },
      ] }) } as GenerateContentResponse;
    }, reserve: async () => {},
  });
  assert.equal(response?.result.values.periods, 15);
  assert.equal(response?.requiresClarification, false);
});

test('the captured provider frequency remains typed even when the inner JSON quotes are omitted', () => {
  const wrap = (field: string, valueJson: string) => ({ operation: 'goal_timeline', language: 'en', parameters: [{ field, valueJson }] });
  assert.equal(planSchema.parse(unwrapPlanningParameters(wrap('frequency', 'monthly'))).frequency, 'monthly');
  assert.equal(planSchema.parse(unwrapPlanningParameters(wrap('frequency', '"monthly"'))).frequency, 'monthly');
  for (const value of ['every second month', 'monthly; record a payment', 'undefined']) assert.throws(() => unwrapPlanningParameters(wrap('frequency', value)));
  assert.throws(() => unwrapPlanningParameters(wrap('contribution', 'monthly')));
  assert.throws(() => unwrapPlanningParameters(wrap('target', 'not JSON')));
});
