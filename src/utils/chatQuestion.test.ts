import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatQuestion } from './chatQuestion';

test('copied formatting is removed without changing monetary, date or JSON inputs', () => {
  for (const value of ['“Who am I?”', '1. “Who am I?”', '- **Who am I?**', '7. **“Who am I?”**', '"1. Who am I?"']) {
    assert.equal(normalizeChatQuestion(value), 'Who am I?');
  }
  for (const value of ['1.00', '1. 1000', '-1000 monthly', '2026-10-15', '₱194,000.00', '{"saved":0}', 'Scenario: {"saved":0}', 'confirm', 'cancel']) {
    assert.equal(normalizeChatQuestion(value), value);
  }
});
