import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

test('PostgreSQL token reservations have unambiguous types and enforce the cap atomically',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    // Never fall back to the application database. Only a generated isolated
    // schema on TEST_DATABASE_URL is created and removed by this test.
    const schema = `casha_test_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const priorSchema = process.env.TEST_DATABASE_SCHEMA, priorCap = process.env.AI_DAILY_TOKEN_CAP;
    process.env.TEST_DATABASE_SCHEMA = schema;
    process.env.AI_DAILY_TOKEN_CAP = '10000';
    let client: { $disconnect: () => Promise<void> } | undefined;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}"."RateLimitBucket" ("key" text PRIMARY KEY, "hits" integer NOT NULL, "expiresAt" timestamptz NOT NULL)`);
      const { prisma } = await import('../src/lib/prisma'); client = prisma;
      const { reserveAiTokens } = await import('../src/services/aiRuntime');
      const date = new Date('2026-10-08T00:00:00Z');
      await reserveAiTokens(6000, date);
      await assert.rejects(reserveAiTokens(5000, date), /AI_GLOBAL_BUDGET_REACHED/);
      const rows = await pool.query(`SELECT "hits" FROM "${schema}"."RateLimitBucket" WHERE "key" = $1`, ['ai-token-cap:2026-10-08']);
      assert.equal(rows.rows[0].hits, 6000);
      await reserveAiTokens(4000, date);
      await assert.rejects(reserveAiTokens(1, date), /AI_GLOBAL_BUDGET_REACHED/);
      await assert.rejects(reserveAiTokens(10001, new Date('2026-10-09')), /AI_GLOBAL_BUDGET_REACHED/);
      const absent = await pool.query(`SELECT "key" FROM "${schema}"."RateLimitBucket" WHERE "key" = $1`, ['ai-token-cap:2026-10-09']);
      assert.equal(absent.rowCount, 0);
    } finally {
      await client?.$disconnect();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
      if (priorSchema === undefined) delete process.env.TEST_DATABASE_SCHEMA; else process.env.TEST_DATABASE_SCHEMA = priorSchema;
      if (priorCap === undefined) delete process.env.AI_DAILY_TOKEN_CAP; else process.env.AI_DAILY_TOKEN_CAP = priorCap;
    }
  });
