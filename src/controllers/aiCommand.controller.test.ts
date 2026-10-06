import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAiDraft } from './aiCommand.controller';

const fare = { intent: 'LOG_TRANSACTION' as const, amount: 100, transactionType: 'EXPENSE' as const, category: 'Transport', description: 'jeepney fare', date: 'today' };

test('wallet clarification preserves the amount, date, category and description even when AI returns nulls', () => {
  const result = resolveAiDraft('Cash', { intent: 'CLARIFY', amount: null, date: null, category: null, walletName: null }, fare);
  assert.deepEqual(result, { ...fare, walletName: 'Cash' });
});

test('wallet clarification cannot silently change a known date or amount from model inference', () => {
  const result = resolveAiDraft('Cash', { intent: 'LOG_TRANSACTION', amount: 200, date: '2026-09-30', description: 'different', category: 'Food & Dining', walletName: 'Cash' }, fare);
  assert.deepEqual(result, { ...fare, walletName: 'Cash' });
});

test('amount and date replies fill only the next missing field', () => {
  const amount = resolveAiDraft('100', { intent: 'GENERAL' }, { ...fare, amount: null });
  assert.equal(amount.amount, 100);
  assert.equal(amount.category, 'Transport');
  const date = resolveAiDraft('today', { intent: 'CLARIFY' }, { ...fare, walletName: 'Cash', date: null });
  assert.equal(date.date, 'today');
  assert.equal(date.walletName, 'Cash');
});

test('explicit expense facts survive an incomplete AI extraction', () => {
  const result = resolveAiDraft('spent 100 on jeepney fare today', { intent: 'CLARIFY', amount: null, category: null });
  assert.equal(result.intent, 'LOG_TRANSACTION');
  assert.equal(result.amount, 100);
  assert.equal(result.date, 'today');
  assert.equal(result.category, 'Transport');
});

test('a new financial request replaces the old draft rather than appending it', () => {
  const result = resolveAiDraft('received 500 salary from Bank yesterday', { intent: 'CLARIFY' }, { ...fare, walletName: 'Cash' });
  assert.equal(result.transactionType, 'INCOME');
  assert.equal(result.amount, 500);
  assert.equal(result.walletName, 'Bank');
  assert.equal(result.date, 'yesterday');
  assert.equal(result.category, 'Salary');
});

test('summary requests do not become replies to a financial draft', () => {
  assert.equal(resolveAiDraft('show my summary', { intent: 'LOG_TRANSACTION' }, fare).intent, 'SUMMARY');
});

test('questions cannot become financial actions from model inference', () => {
  for (const question of ['What do you mean by a transaction?', 'Why would I need an account?', 'How do I track spending?']) {
    assert.equal(resolveAiDraft(question, { intent: 'LOG_TRANSACTION', amount: 194990 }, fare).intent, 'GENERAL');
  }
});

test('an explicit contribution to a named goal works without requiring the word fund', () => {
  const draft = resolveAiDraft('Save 500 to Phone from Cash today', { intent: 'CLARIFY' });
  assert.equal(draft.intent, 'ADD_SAVINGS');
  assert.equal(draft.goalName, 'Phone');
  assert.equal(draft.walletName, 'Cash');
  assert.equal(draft.amount, 500);
  assert.equal(draft.date, 'today');
});
