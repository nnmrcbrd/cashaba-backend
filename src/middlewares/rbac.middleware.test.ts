import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { authorize } from './rbac.middleware';

function runAuthorization(accountRole: string | undefined, profileRoles: string[], allowed: Array<'USER' | 'ADMIN'>) {
  let statusCode = 200;
  let responseBody: unknown;
  let nextCalled = false;
  const req = {
    user: accountRole ? {
      userId: 'user-1',
      id: 'user-1',
      accountRole,
      roles: profileRoles,
      authMethod: 'LOCAL' as const,
    } : undefined,
  } as Request;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as unknown as Response;
  const next = (() => { nextCalled = true; }) as NextFunction;

  authorize(allowed)(req, res, next);
  return { statusCode, responseBody, nextCalled };
}

test('requires an authenticated identity', () => {
  const result = runAuthorization(undefined, [], ['USER']);
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);
});

test('profile labels never grant administrator permission', () => {
  const result = runAuthorization('USER', ['ADMIN'], ['ADMIN']);
  assert.equal(result.statusCode, 403);
  assert.equal(result.nextCalled, false);
});

test('allows only the matching system account role', () => {
  assert.equal(runAuthorization('ADMIN', ['STUDENT'], ['ADMIN']).nextCalled, true);
  assert.equal(runAuthorization('USER', ['WORKING'], ['USER']).nextCalled, true);
  assert.equal(runAuthorization('ADMIN', [], ['USER']).statusCode, 403);
});
