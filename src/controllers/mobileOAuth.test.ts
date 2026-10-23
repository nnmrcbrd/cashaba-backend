import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import { prisma } from '@/lib/prisma';
import type { FinancialTx } from '@/services/financialOperation';
import { exchangeMobileGoogle, finishGoogleOAuth, startGoogleOAuth } from './auth.controller';
import { mobileHandoffFingerprint, mobileProofChallenge } from '@/utils/mobileOAuth';

function captureResponse() {
  const headers = new Map<string, string | number | readonly string[]>();
  let body: Record<string, unknown> = {};
  let redirect = '';
  const res = Object.assign(Object.create(express.response), {
    req: {}, statusCode: 200,
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    setHeader(name: string, value: string | number | readonly string[]) { headers.set(name.toLowerCase(), value); return this; },
    json(value: Record<string, unknown>) { body = value; return this; },
    redirect(url: string) { redirect = url; return this; },
  }) as Response;
  return { res, get body() { return body; }, get redirect() { return redirect; }, get cookies() {
    const value = headers.get('set-cookie');
    return Array.isArray(value) ? [...value] : value ? [String(value)] : [];
  } };
}

type Grant = { id: string; token: string; userId: string; type: string; expiresAt: Date; consumedAt: Date | null; revokedAt: Date | null };
type Where = { id?: string; token?: string; userId?: string; type?: string; consumedAt?: null; revokedAt?: null; expiresAt?: { gt: Date } };
function matches(grant: Grant, where: Where) {
  return (!where.id || grant.id === where.id) && (!where.token || grant.token === where.token)
    && (!where.userId || grant.userId === where.userId) && (!where.type || grant.type === where.type)
    && (!('consumedAt' in where) || grant.consumedAt === null) && (!('revokedAt' in where) || grant.revokedAt === null)
    && (!where.expiresAt || grant.expiresAt > where.expiresAt.gt);
}

test('native Google login uses a one-time PKCE handoff and issues HttpOnly app cookies', async t => {
  const envNames = ['NODE_ENV', 'COOKIE_DOMAIN', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'] as const;
  const oldEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const oldTransaction = prisma.$transaction;
  const oldFindUser = prisma.user.findUnique;
  const oldFindToken = prisma.token.findUnique;
  const grants = new Map<string, Grant>();
  let sequence = 0;
  const verifier = 'a'.repeat(43);
  const challenge = mobileProofChallenge(verifier);
  const user = { id: 'native-fixture-user', email: 'native@example.test', firstName: 'Native', lastName: 'Fixture',
    password: 'never-return-this-field', accountRole: 'USER', accountStatus: 'ACTIVE', roles: [], sessionVersion: 1,
    googleSubject: 'native-fixture-google-subject', avatarUrl: null, createdAt: new Date(), onboardingCompletedAt: new Date() };
  const tx = {
    $queryRawUnsafe: async () => [{ id: user.id }],
    user: { findUniqueOrThrow: async () => user, update: async () => user },
    token: {
      create: async ({ data }: { data: Omit<Grant, 'id' | 'consumedAt' | 'revokedAt'> }) => {
        const grant = { ...data, id: `native-token-${++sequence}`, consumedAt: null, revokedAt: null };
        grants.set(grant.token, grant); return grant;
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<Grant> }) => {
        let count = 0;
        for (const grant of grants.values()) if (matches(grant, where)) { Object.assign(grant, data); count++; }
        return { count };
      },
    },
  } as unknown as FinancialTx;
  try {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_DOMAIN = '.casha-ba.online';
    process.env.JWT_ACCESS_SECRET = 'native-test-only-access-secret';
    process.env.JWT_REFRESH_SECRET = 'native-test-only-refresh-secret';
    process.env.GOOGLE_CLIENT_ID = 'native-fixture-client';
    process.env.GOOGLE_CLIENT_SECRET = 'native-fixture-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'https://api.example.test/api/auth/google/callback';
    prisma.$transaction = (async (work: (db: FinancialTx) => Promise<unknown>) => {
      const snapshot = new Map([...grants].map(([key, grant]) => [key, { ...grant }]));
      try { return await work(tx); }
      catch (error) { grants.clear(); snapshot.forEach((grant, key) => grants.set(key, grant)); throw error; }
    }) as typeof prisma.$transaction;
    prisma.user.findUnique = (async () => user) as unknown as typeof prisma.user.findUnique;
    prisma.token.findUnique = (async ({ where }: { where: { token: string } }) => grants.get(where.token) || null) as unknown as typeof prisma.token.findUnique;
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') return new globalThis.Response(JSON.stringify({ access_token: 'native-fixture-provider-token' }));
      assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo');
      return new globalThis.Response(JSON.stringify({ sub: user.googleSubject, email: user.email, email_verified: true, given_name: user.firstName, family_name: user.lastName }));
    });

    async function issueCode() {
      const start = captureResponse();
      await startGoogleOAuth({ query: { client: 'android', code_challenge: challenge, code_challenge_method: 'S256' } } as unknown as Request, start.res);
      const state = new URL(start.redirect).searchParams.get('state');
      assert.ok(state?.startsWith('android.'));
      const finish = captureResponse();
      await finishGoogleOAuth({ query: { state, code: 'native-fixture-authorization-code' }, cookies: { googleOAuthState: state } } as unknown as Request, finish.res);
      const destination = new URL(finish.redirect);
      assert.equal(destination.protocol, 'cashaba:');
      assert.equal(destination.hostname, 'auth');
      assert.equal(destination.pathname, '/google/callback');
      assert.equal(destination.searchParams.has('accessToken'), false);
      assert.equal(destination.searchParams.has('refreshToken'), false);
      assert.equal(finish.cookies.some(cookie => /^refreshToken=[^;]/.test(cookie)), false);
      const code = destination.searchParams.get('code');
      assert.match(code || '', /^[A-Za-z0-9_-]{43}$/);
      return code!;
    }
    async function exchange(code: string, proof = verifier) {
      const response = captureResponse();
      await exchangeMobileGoogle({ body: { code, verifier: proof } } as Request, response.res);
      return response;
    }

    await t.test('Android launch requires an S256 challenge', async () => {
      const response = captureResponse();
      await startGoogleOAuth({ query: { client: 'android' } } as unknown as Request, response.res);
      assert.equal(response.res.statusCode, 400);
    });
    await t.test('wrong proof fails, correct proof works once, and session tokens stay out of the URL', async () => {
      const code = await issueCode();
      assert.equal((await exchange(code, 'b'.repeat(43))).res.statusCode, 401);
      const response = await exchange(code);
      assert.equal(response.res.statusCode, 200);
      assert.equal(typeof response.body.accessToken, 'string');
      assert.equal(response.body.refreshToken, undefined);
      assert.equal((response.body.user as Record<string, unknown>).password, undefined);
      const cookie = response.cookies.find(value => /^refreshToken=[^;]/.test(value));
      assert.ok(cookie);
      assert.match(cookie, /; HttpOnly/);
      assert.match(cookie, /; Secure/);
      assert.match(cookie, /; SameSite=None/);
      assert.equal((await exchange(code)).res.statusCode, 401);
    });
    await t.test('expired and revoked handoffs cannot establish a session', async () => {
      const expired = await issueCode();
      grants.get(mobileHandoffFingerprint(expired, challenge))!.expiresAt = new Date(Date.now() - 1);
      assert.equal((await exchange(expired)).res.statusCode, 401);
      const revoked = await issueCode();
      grants.get(mobileHandoffFingerprint(revoked, challenge))!.revokedAt = new Date();
      assert.equal((await exchange(revoked)).res.statusCode, 401);
    });
    await t.test('suspension during browser login prevents an app session', async () => {
      const code = await issueCode();
      user.accountStatus = 'SUSPENDED';
      assert.equal((await exchange(code)).res.statusCode, 401);
      user.accountStatus = 'ACTIVE';
      assert.equal((await exchange(code)).res.statusCode, 200, 'Failed exchanges roll back their one-time claim');
    });
  } finally {
    prisma.$transaction = oldTransaction;
    prisma.user.findUnique = oldFindUser;
    prisma.token.findUnique = oldFindToken;
    for (const name of envNames) { if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name]; }
  }
});
