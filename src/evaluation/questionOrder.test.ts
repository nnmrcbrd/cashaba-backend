import test from 'node:test';
import assert from 'node:assert/strict';
import { orderEvaluationQuestions } from './questionOrder';

test('prioritizing remaining live cases retains all questions and original data', () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, question: `Question ${index + 1}` }));
  const before = JSON.stringify(rows);
  const priority = [...Array.from({ length: 27 }, (_, index) => index + 124), 31, 37, 84, 87, 123];
  const result = orderEvaluationQuestions(rows, priority.join(','));
  assert.deepEqual(result.questions.slice(0, 32).map(row => row.id), priority);
  assert.equal(result.questions.length, 150);
  assert.equal(new Set(result.questions.map(row => row.id)).size, 150);
  assert.deepEqual(result.questions.map(row => row.id).sort((a, b) => a - b), rows.map(row => row.id));
  assert.equal(JSON.stringify(rows), before);
  assert.ok(result.questions.every(row => rows.includes(row)));
});

test('evaluation ordering rejects duplicate, unknown and malformed priority IDs', () => {
  for (const raw of ['1,1', '0', '3', '-1', '1.5', '1,,2', 'abc', '1e0', '999999999999999999999']) {
    assert.throws(() => orderEvaluationQuestions([{ id: 1 }, { id: 2 }], raw));
  }
});

test('no priority keeps the original evaluation coverage and order', () => {
  const rows = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(orderEvaluationQuestions(rows), { questions: rows, priorityIds: [] });
});
