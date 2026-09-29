import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReceiptModelResponse } from './receiptScan';

test('parses a valid receipt result from surrounding model text', () => {
  const parsed = parseReceiptModelResponse(`Result:\n\`\`\`json\n{
    "amount": 249.5,
    "description": "Sample Store",
    "date": "2026-09-20",
    "category": "Shopping",
    "transactionType": "EXPENSE"
  }\n\`\`\``);

  assert.deepEqual(parsed, {
    amount: 249.5,
    description: 'Sample Store',
    date: '2026-09-20',
    category: 'Shopping',
    transactionType: 'EXPENSE',
  });
});

test('rejects malformed or incomplete model output', () => {
  assert.equal(parseReceiptModelResponse('{"amount": "unknown"}'), null);
  assert.equal(parseReceiptModelResponse('No transaction was visible.'), null);
});
