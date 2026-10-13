import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const root = new URL('../', import.meta.url);
const prismaCli = fileURLToPath(new URL('node_modules/prisma/build/index.js', root));
// Only this retained history is represented by the baseline + raw RAG SQL.
// Later migrations must run through migrate deploy, never be marked applied.
const baselineThrough = '20261009220000_trial_and_subscription_tiers';

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: fileURLToPath(root), env: process.env, encoding: 'utf8',
    // Prisma diagnostics can contain database identifiers. Report only the
    // failed operation here; inspect private server diagnostics separately.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`Prisma ${args.slice(0, 2).join(' ')} failed`);
}

export async function initializeEmptyDatabase(client, prisma = runPrisma) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(70313001)');
    const result = await client.query(`SELECT
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S'))
      OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_%' AND t.typtype = 'e') AS occupied`);
    if (result.rows[0]?.occupied !== false) {
      throw new Error('Database is not empty. Initialization refused; use migrate deploy for an existing Casha-Ba database.');
    }
    await client.query('SET LOCAL search_path TO public');
    await client.query(await readFile(new URL('prisma/fresh-baseline.sql', root), 'utf8'));
    // The retained baseline intentionally precedes the raw pgvector tables,
    // which are not represented in the generated Prisma baseline.
    await client.query(await readFile(new URL('prisma/migrations/20261009090000_semantic_assistant_knowledge/migration.sql', root), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  const entries = await readdir(new URL('prisma/migrations/', root), { withFileTypes: true });
  const migrations = entries.filter(entry => entry.isDirectory() && entry.name <= baselineThrough).map(entry => entry.name).sort();
  for (const migration of migrations) {
    await prisma(['migrate', 'resolve', '--applied', migration]);
  }
  await prisma(['migrate', 'deploy']);
  console.log(`Initialized an empty Casha-Ba database, including pgvector; ${migrations.length} baseline migrations recorded.`);
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--confirm-empty') {
    throw new Error('Initialization requires --confirm-empty and a verified new, empty database.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const schema = new URL(process.env.DATABASE_URL).searchParams.get('schema');
  if (schema && schema !== 'public') throw new Error('Empty-database initialization supports only the public schema');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await initializeEmptyDatabase(client); }
  finally { await client.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Database initialization failed');
    process.exitCode = 1;
  });
}
