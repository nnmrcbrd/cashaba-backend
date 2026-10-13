import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeEmptyDatabase } from './init-empty-database.mjs';

test('an existing database is rejected before baseline or migration writes', async () => {
  const statements = [], migrations = [];
  const client = { async query(sql) {
    statements.push(sql);
    return { rows: [{ occupied: true }] };
  } };
  await assert.rejects(initializeEmptyDatabase(client, args => migrations.push(args)), /not empty/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.ok(statements.every(sql => !sql.includes('CREATE TABLE')));
  assert.deepEqual(migrations, []);
});

test('a baseline/pgvector failure rolls back and never marks migrations applied', async () => {
  const statements = [], migrations = [];
  const client = { async query(sql) {
    statements.push(sql);
    if (sql.includes('CREATE EXTENSION')) throw new Error('vector extension unavailable');
    return { rows: [{ occupied: false }] };
  } };
  await assert.rejects(initializeEmptyDatabase(client, args => migrations.push(args)), /vector extension unavailable/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.ok(!statements.includes('COMMIT'));
  assert.deepEqual(migrations, []);
});

test('only an empty database receives baseline plus RAG before Prisma history is resolved', async () => {
  const statements = [], migrations = [];
  const client = { async query(sql) {
    statements.push(sql);
    return { rows: [{ occupied: false }] };
  } };
  await initializeEmptyDatabase(client, args => {
    assert.equal(statements.at(-1), 'COMMIT');
    migrations.push(args);
  });
  assert.ok(statements.some(sql => sql.includes('CREATE TABLE "User"')));
  assert.ok(statements.some(sql => sql.includes('CREATE TABLE "KnowledgeBase"') && sql.includes('vector(768)')));
  assert.ok(migrations.some(args => args.includes('20260717070610_init')));
  assert.ok(migrations.some(args => args.includes('20261009090000_semantic_assistant_knowledge')));
  assert.deepEqual(migrations.at(-1), ['migrate', 'deploy']);
});
