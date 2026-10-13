import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';
import { loginWithGoogle, refreshUserSession, signRefreshToken, tokenFingerprint } from './auth';
import type { FinancialTx } from './financialOperation';

test('a verified Google login resets idle activity once; rotation cannot reuse the marker', async t => {
  const previousAccess = process.env.JWT_ACCESS_SECRET, previousRefresh = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_ACCESS_SECRET = 'isolated-test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'isolated-test-refresh-secret';
  const user = { id: 'fixture-owner', googleSubject: 'fixture-google-subject', email: 'fixture@example.test',
    firstName: 'Fixture', lastName: 'Owner', accountRole: 'USER', accountStatus: 'ACTIVE',
    roles: [], sessionVersion: 1, localCredentialVerified: true, onboardingCompletedAt: new Date(),
    avatarUrl: null, createdAt: new Date() };
  const tokens = new Map<string, { consumed: boolean }>();
  const tx = {
    $queryRawUnsafe: async () => [{ id: user.id }],
    user: { findUniqueOrThrow: async () => user, update: async () => user },
    token: {
      create: async ({ data }: { data: { token: string } }) => { tokens.set(data.token, { consumed: false }); return data; },
      updateMany: async ({ where }: { where: { token: string } }) => {
        const row = tokens.get(where.token);
        if (!row || row.consumed) return { count: 0 };
        row.consumed = true; return { count: 1 };
      },
    },
  } as unknown as FinancialTx;
  const previousTransaction = prisma.$transaction, previousFindUser = prisma.user.findUnique;
  try {
    // Prisma delegate methods use a proxy instead of own property descriptors.
    prisma.$transaction = (async (work: (value: FinancialTx) => Promise<unknown>) => work(tx)) as typeof prisma.$transaction;
    prisma.user.findUnique = (async () => user) as unknown as typeof prisma.user.findUnique;
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('Session regression must not call a live service'); });
    const login = await loginWithGoogle({ subject: user.googleSubject, email: user.email, emailVerified: true,
      firstName: user.firstName, lastName: user.lastName });
    assert.equal((jwt.verify(login.refreshToken, process.env.JWT_REFRESH_SECRET) as jwt.JwtPayload).freshSignIn, true);
    const first = await refreshUserSession(login.refreshToken);
    assert.equal(first.freshSignIn, true);
    assert.equal((jwt.verify(first.refreshToken, process.env.JWT_REFRESH_SECRET) as jwt.JwtPayload).freshSignIn, undefined);
    const later = await refreshUserSession(first.refreshToken);
    assert.equal(later.freshSignIn, false);
    const staleInitial = jwt.sign({ userId: user.id, authMethod: 'GOOGLE', sessionVersion: 1,
      freshSignIn: true, iat: Math.floor(Date.now() / 1000) - 16 * 60 }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
    tokens.set(tokenFingerprint(staleInitial), { consumed: false });
    assert.equal((await refreshUserSession(staleInitial)).freshSignIn, false,
      'An old unconsumed initial token must not restart an expired idle window');
    await assert.rejects(refreshUserSession(login.refreshToken), /no longer active/);
    await assert.rejects(loginWithGoogle({ subject: user.googleSubject, email: user.email, emailVerified: false }), /verified identity/);
  } finally {
    prisma.$transaction = previousTransaction; prisma.user.findUnique = previousFindUser;
    if (previousAccess === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousAccess;
    if (previousRefresh === undefined) delete process.env.JWT_REFRESH_SECRET; else process.env.JWT_REFRESH_SECRET = previousRefresh;
  }
});

test('ordinary and local refresh tokens do not carry a fresh Google sign-in marker', () => {
  const previous = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_REFRESH_SECRET = 'isolated-test-refresh-secret';
  try {
    for (const token of [signRefreshToken('fixture-owner', 'GOOGLE', 1), signRefreshToken('fixture-owner', 'LOCAL', 1, true)]) {
      assert.equal((jwt.verify(token, process.env.JWT_REFRESH_SECRET) as jwt.JwtPayload).freshSignIn, undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.JWT_REFRESH_SECRET; else process.env.JWT_REFRESH_SECRET = previous;
  }
});
