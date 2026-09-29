import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Prisma } from '@/generated/prisma/client';
import { prisma, qualifiedTable } from '@/lib/prisma';

export type FinancialTx = Prisma.TransactionClient;
export class FinancialError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function requestOperation(req: Request) {
  const key = req.get('Idempotency-Key');
  if (!key) return undefined;
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(key)) throw new FinancialError('Invalid idempotency key');
  return { key: `request:${key}`, payload: { method: req.method, path: req.originalUrl, body: req.body } };
}

export async function withFinancialOperation<T>(userId: string, work: (tx: FinancialTx) => Promise<T>, operation?: { key: string; payload: unknown }): Promise<T> {
  return prisma.$transaction(async tx => {
    // All reads that inform financial writes happen AFTER this lock. PostgreSQL
    // ReadCommitted gives the next waiter the preceding operation's committed state.
    const userTable = qualifiedTable('User');
    const users = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM ${userTable} WHERE id = $1 FOR UPDATE`, userId);
    if (!users.length) throw new FinancialError('Account not found', 404);
    const hash = operation ? fingerprint(operation.payload) : '';
    if (operation) {
      const existing = await tx.financialOperation.findUnique({ where: { userId_key: { userId, key: operation.key } } });
      if (existing) {
        if (existing.payloadHash !== hash) throw new FinancialError('This retry key was already used for a different request', 409);
        return existing.result as T;
      }
    }
    const result = await work(tx);
    if (operation) await tx.financialOperation.create({ data: { userId, key: operation.key, payloadHash: hash, result: jsonValue(result) } });
    return result;
  }, { isolationLevel: 'ReadCommitted', maxWait: 15_000, timeout: 30_000 });
}

export async function requireWallet(tx: FinancialTx, userId: string, walletId?: string | null) {
  if (!walletId || !await tx.wallet.findFirst({ where: { id: walletId, userId } })) throw new FinancialError('Select an account belonging to you');
}
export function financialResponse(res: Response, error: unknown, fallback: string) {
  if (error instanceof FinancialError) return res.status(error.status).json({ message: error.message });
  console.error(fallback, error);
  return res.status(500).json({ message: fallback });
}
