import type { NextFunction, Request, Response } from "express";
import { createHash } from 'node:crypto';
import { prisma, qualifiedTable } from '@/lib/prisma';

interface Entry { count: number; resetAt: number }

export async function databaseRateLimit(key: string, windowMs: number): Promise<Entry> {
  const table = qualifiedTable('RateLimitBucket');
  const rows = await prisma.$queryRawUnsafe<Array<{ hits: number; remainingMs: number }>>(
    `INSERT INTO ${table} AS bucket ("key", "hits", "expiresAt") VALUES ($1, 1, clock_timestamp() + $2 * interval '1 millisecond')
     ON CONFLICT ("key") DO UPDATE SET
       "hits" = CASE WHEN bucket."expiresAt" <= clock_timestamp() THEN 1 ELSE bucket."hits" + 1 END,
       "expiresAt" = CASE WHEN bucket."expiresAt" <= clock_timestamp() THEN clock_timestamp() + $2 * interval '1 millisecond' ELSE bucket."expiresAt" END
     RETURNING "hits", GREATEST(0, EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())) * 1000)::double precision AS "remainingMs"`, key, windowMs,
  );
  if (!rows[0]) throw new Error('RATE_LIMIT_STORE_UNAVAILABLE');
  const remainingMs = Number(rows[0].remainingMs);
  if (!Number.isFinite(remainingMs)) throw new Error('RATE_LIMIT_STORE_UNAVAILABLE');
  // Expired keys contain no useful counters and must not grow without bound.
  if (Math.random() < 0.01) await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE "key" IN (SELECT "key" FROM ${table} WHERE "expiresAt" < clock_timestamp() LIMIT 1000)`);
  // Return a duration from the database clock. Raw timestamptz conversion can
  // shift the displayed deadline when the database and Node use different zones.
  return { count: rows[0].hits, resetAt: Date.now() + Math.ceil(remainingMs) };
}

export function rateLimit(options: { windowMs: number; max: number }) {
  const entries = new Map<string, Entry>();
  return async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = createHash('sha256').update(`${options.windowMs}:${options.max}:${req.ip}:${req.user?.userId || 'anonymous'}:${req.baseUrl}:${req.path}`).digest('hex');
    const current = entries.get(key);
    let entry: Entry;
    if (process.env.RATE_LIMIT_STORE === 'postgres' || process.env.NODE_ENV === 'production') {
      try { entry = await databaseRateLimit(key, options.windowMs); }
      catch { res.status(503).json({ message: 'Request protection is temporarily unavailable. Try again shortly.' }); return; }
    } else {
      for (const [storedKey, stored] of entries) if (stored.resetAt <= now) entries.delete(storedKey);
      if (!current && entries.size >= 10_000) { res.status(503).json({ message: 'Request protection is temporarily busy' }); return; }
      entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current;
      entry.count += 1;
      entries.set(key, entry);
    }
    res.setHeader("RateLimit-Limit", options.max);
    res.setHeader("RateLimit-Remaining", Math.max(0, options.max - entry.count));
    if (entry.count > options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", retryAfterSeconds);
      res.status(429).json({ message: "Too many attempts. Please try again later.", retryAfterSeconds });
      return;
    }
    next();
  };
}
