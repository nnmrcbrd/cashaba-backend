import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import type { FinancialTx } from '@/services/financialOperation';
import { login, refresh, logout, finishGoogleOAuth } from './auth.controller';

// Use Express's actual Set-Cookie serialization without opening a server or
// contacting the application database, Google or any other external service.
function responseCapture() {
  const headers = new Map<string, string | number | readonly string[]>();
  let body: Record<string, unknown> | undefined;
  let redirect: string | undefined;
  const res = Object.assign(Object.create(express.response), {
    req: {},
    statusCode: 200,
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    json(value: Record<string, unknown>) { body = value; return this; },
    redirect(url: string) { redirect = url; },
  }) as Response;
  return {
    res,
    get body() { return body; },
    get redirect() { return redirect; },
    get cookies(): string[] {
      const value = headers.get('set-cookie');
      return Array.isArray(value) ? [...value] : value ? [String(value)] : [];
    },
  };
}

function activeRefreshCookie(cookies: string[]) {
  const cookie = cookies.find(value => /^refreshToken=[^;]/.test(value));
  assert.ok(cookie, 'The response must issue a refresh cookie');
  return cookie;
}

function assertExpiredCookie(cookie: string) {
  assert.match(cookie, /^refreshToken=;/);
  assert.match(cookie, /; Path=\/api\/auth(?:;|$)/);
  assert.match(cookie, /; Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.doesNotMatch(cookie, /Max-Age=/);
}

test('actual authentication handlers issue, rotate and clear cookies across production subdomains', async t => {
  const envNames = ['NODE_ENV', 'COOKIE_DOMAIN', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
    'FRONTEND_URL', 'BACKEND_URL', 'GOOGLE_REDIRECT_URI', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
  const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const password = 'fixture-password-123';
  const user = { id: 'cookie-fixture-owner', email: 'fixture@example.test',
    password: await bcrypt.hash(password, 4), firstName: 'Fixture', lastName: 'Owner',
    localCredentialVerified: true, accountRole: 'USER', accountStatus: 'ACTIVE', roles: [],
    sessionVersion: 1, googleSubject: 'cookie-fixture-google-subject', avatarUrl: null,
    createdAt: new Date(), onboardingCompletedAt: new Date() };
  const tokens = new Map<string, { consumed: boolean }>();
  const tx = {
    $queryRawUnsafe: async () => [{ id: user.id }],
    user: { findUniqueOrThrow: async () => user, update: async () => user },
    token: {
      create: async ({ data }: { data: { token: string } }) => {
        tokens.set(data.token, { consumed: false }); return data;
      },
      updateMany: async ({ where }: { where: { token: string } }) => {
        const token = tokens.get(where.token);
        if (!token || token.consumed) return { count: 0 };
        token.consumed = true; return { count: 1 };
      },
    },
  } as unknown as FinancialTx;
  const previousTransaction = prisma.$transaction;
  const previousFindUser = prisma.user.findUnique;
  const previousRevoke = prisma.token.updateMany;
  let revocations = 0;
  let refreshToken = '';
  try {
    prisma.$transaction = (async (work: (value: FinancialTx) => Promise<unknown>) => work(tx)) as typeof prisma.$transaction;
    prisma.user.findUnique = (async () => user) as unknown as typeof prisma.user.findUnique;
    prisma.token.updateMany = (async () => { revocations++; return { count: 1 }; }) as typeof prisma.token.updateMany;
    process.env.JWT_ACCESS_SECRET = 'cookie-test-access-secret';
    process.env.JWT_REFRESH_SECRET = 'cookie-test-refresh-secret';
    process.env.FRONTEND_URL = 'https://www.cloomero.cloud';
    process.env.BACKEND_URL = 'https://api.cloomero.cloud';
    process.env.GOOGLE_REDIRECT_URI = 'https://api.cloomero.cloud/api/auth/google/callback';
    process.env.GOOGLE_CLIENT_ID = 'fixture-google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'fixture-google-client-secret';
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new globalThis.Response(JSON.stringify({ access_token: 'fixture-google-access-token' }), { status: 200 });
      }
      assert.equal(String(input), 'https://openidconnect.googleapis.com/v1/userinfo', 'Unexpected external call');
      return new globalThis.Response(JSON.stringify({ sub: user.googleSubject, email: user.email,
        email_verified: true, given_name: user.firstName, family_name: user.lastName }), { status: 200 });
    });
    const loginRequest = { body: { email: user.email, password } } as Request;

    await t.test('localhost login ignores the production domain and keeps a usable Lax cookie', async () => {
      process.env.NODE_ENV = 'development';
      process.env.COOKIE_DOMAIN = '.cloomero.cloud';
      const result = responseCapture();
      await login(loginRequest, result.res);
      assert.equal(result.res.statusCode, 200);
      assert.equal(result.cookies.length, 1);
      const cookie = activeRefreshCookie(result.cookies);
      assert.match(cookie, /; HttpOnly/);
      assert.match(cookie, /; Path=\/api\/auth/);
      assert.match(cookie, /; Max-Age=604800/);
      assert.match(cookie, /; SameSite=Lax/);
      assert.doesNotMatch(cookie, /; (?:Domain=|Secure)/);
      assert.equal(typeof result.body?.accessToken, 'string');
      assert.equal(result.cookies.some(value => value.startsWith('accessToken=')), false);
    });

    await t.test('production without a shared domain retains a secure API-host cookie', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.COOKIE_DOMAIN;
      const result = responseCapture();
      await login(loginRequest, result.res);
      assert.equal(result.res.statusCode, 200);
      assert.equal(result.cookies.length, 1);
      const cookie = activeRefreshCookie(result.cookies);
      assert.match(cookie, /; Secure/);
      assert.match(cookie, /; SameSite=None/);
      assert.doesNotMatch(cookie, /; Domain=/);
    });

    await t.test('shared-domain login expires the old host cookie before issuing the new session', async () => {
      process.env.COOKIE_DOMAIN = ' .cloomero.cloud ';
      const result = responseCapture();
      await login(loginRequest, result.res);
      assert.equal(result.res.statusCode, 200);
      assert.equal(result.cookies.length, 2);
      assertExpiredCookie(result.cookies[0]);
      assert.doesNotMatch(result.cookies[0], /; Domain=/);
      const cookie = activeRefreshCookie(result.cookies);
      assert.match(cookie, /; Domain=\.cloomero\.cloud(?:;|$)/);
      assert.match(cookie, /; HttpOnly/);
      assert.match(cookie, /; Secure/);
      assert.match(cookie, /; SameSite=None/);
      assert.match(cookie, /; Max-Age=604800/);
      refreshToken = cookie.split(';')[0].slice('refreshToken='.length);
    });

    await t.test('refresh rotation uses the same shared cookie domain and path', async () => {
      const result = responseCapture();
      await refresh({ cookies: { refreshToken } } as unknown as Request, result.res);
      assert.equal(result.res.statusCode, 200);
      assert.equal(typeof result.body?.accessToken, 'string');
      const cookie = activeRefreshCookie(result.cookies);
      assert.match(cookie, /; Domain=\.cloomero\.cloud(?:;|$)/);
      assert.match(cookie, /; Path=\/api\/auth(?:;|$)/);
      assert.match(cookie, /; Secure/);
      assert.match(cookie, /; SameSite=None/);
      const rotatedToken = cookie.split(';')[0].slice('refreshToken='.length);
      assert.notEqual(rotatedToken, refreshToken);
      refreshToken = rotatedToken;
    });

    await t.test('logout revokes the session and expires both shared and old host cookies', async () => {
      const result = responseCapture();
      await logout({ cookies: { refreshToken } } as unknown as Request, result.res);
      assert.equal(result.res.statusCode, 200);
      assert.equal(revocations, 1);
      assert.equal(result.cookies.length, 2);
      result.cookies.forEach(assertExpiredCookie);
      assert.match(result.cookies[0], /; Domain=\.cloomero\.cloud(?:;|$)/);
      assert.doesNotMatch(result.cookies[1], /; Domain=/);
    });

    await t.test('an invalid refresh token also clears both cookie scopes', async () => {
      const result = responseCapture();
      await refresh({ cookies: { refreshToken: 'invalid-fixture-token' } } as unknown as Request, result.res);
      assert.equal(result.res.statusCode, 401);
      assert.equal(result.cookies.length, 2);
      result.cookies.forEach(assertExpiredCookie);
      assert.match(result.cookies[0], /; Domain=\.cloomero\.cloud(?:;|$)/);
      assert.doesNotMatch(result.cookies[1], /; Domain=/);
    });

    await t.test('Google sign-in shares the refresh cookie while OAuth state remains API-host scoped', async () => {
      const result = responseCapture();
      await finishGoogleOAuth({ query: { state: 'fixture-oauth-state', code: 'fixture-oauth-code' },
        cookies: { googleOAuthState: 'fixture-oauth-state' } } as unknown as Request, result.res);
      assert.equal(result.redirect, 'https://www.cloomero.cloud/auth/google/callback');
      const cookie = activeRefreshCookie(result.cookies);
      assert.match(cookie, /; Domain=\.cloomero\.cloud(?:;|$)/);
      assert.match(cookie, /; Secure/);
      const stateCookie = result.cookies.find(value => value.startsWith('googleOAuthState='));
      assert.ok(stateCookie);
      assert.doesNotMatch(stateCookie, /; Domain=/);
      assert.match(stateCookie, /; SameSite=Lax/);
    });
  } finally {
    prisma.$transaction = previousTransaction;
    prisma.user.findUnique = previousFindUser;
    prisma.token.updateMany = previousRevoke;
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  }
});
