import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import app from '@/app';
import { prisma } from '@/lib/prisma';

type HttpResult = { status: number; headers: IncomingHttpHeaders };
function call(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('Synthetic CORS HTTP test timed out')));
    req.end();
  });
}

test('actual API CORS and session-origin protection accept web and packaged Android origins', async t => {
  const names = ['NODE_ENV', 'FRONTEND_URL', 'CORS_ALLOWED_ORIGINS'] as const;
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousQuery = prisma.$queryRawUnsafe;
  const previousExecute = prisma.$executeRawUnsafe;
  let rateChecks = 0;
  const server = createServer(app);
  try {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://www.casha-ba.online/';
    delete process.env.CORS_ALLOWED_ORIGINS;
    // A missing-token refresh still passes through production request limiting.
    // Stub only its counters; no application database or provider is contacted.
    prisma.$queryRawUnsafe = (async (sql: string) => {
      assert.ok(sql.includes('"RateLimitBucket"'), 'Unexpected database query');
      rateChecks++;
      return [{ hits: 1, remainingMs: 60_000 }];
    }) as typeof prisma.$queryRawUnsafe;
    prisma.$executeRawUnsafe = (async (sql: string) => {
      assert.ok(sql.includes('"RateLimitBucket"'), 'Unexpected database mutation');
      return 0;
    }) as typeof prisma.$executeRawUnsafe;
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('CORS tests must not contact a provider'); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    const allowed = ['https://www.casha-ba.online', 'https://casha-ba.online', 'https://api.casha-ba.online', 'https://localhost'];

    await t.test('GET and OPTIONS responses allow credentials and echo each exact trusted origin', async () => {
      for (const origin of allowed) {
        const result = await call(port, 'GET', '/', { Origin: origin });
        assert.equal(result.status, 200);
        assert.equal(result.headers['access-control-allow-origin'], origin);
        assert.equal(result.headers['access-control-allow-credentials'], 'true');
        assert.match(String(result.headers.vary), /(?:^|,\s*)Origin(?:,|$)/i);
        assert.match(String(result.headers['access-control-expose-headers']), /Retry-After/);
        const preflight = await call(port, 'OPTIONS', '/api/auth/refresh', {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers['access-control-allow-origin'], origin);
        assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
        assert.match(String(preflight.headers['access-control-allow-methods']), /POST/);
        for (const header of ['authorization', 'content-type', 'idempotency-key']) {
          assert.ok(String(preflight.headers['access-control-allow-headers']).toLowerCase().split(',').includes(header));
        }
      }
      assert.equal(rateChecks, 0, 'Preflight must complete before protected auth handlers');
    });

    await t.test('all trusted origins reach refresh authentication instead of failing the origin guard', async () => {
      for (const origin of allowed) {
        const result = await call(port, 'POST', '/api/auth/refresh', { Origin: origin });
        assert.equal(result.status, 401, 'A missing token must reach auth, not receive an origin rejection');
        assert.equal(result.headers['access-control-allow-origin'], origin);
      }
      assert.equal(rateChecks, allowed.length);
    });

    await t.test('foreign origins, lookalike hosts, HTTP, unlisted subdomains and ports are rejected', async () => {
      const forbidden = ['https://evil.test', 'https://casha-ba.online.evil.test',
        'https://evil-casha-ba.online', 'https://preview.casha-ba.online',
        'http://casha-ba.online', 'https://api.casha-ba.online:8443', 'null'];
      const previousChecks = rateChecks;
      for (const origin of forbidden) {
        const get = await call(port, 'GET', '/', { Origin: origin });
        assert.equal(get.headers['access-control-allow-origin'], undefined);
        const preflight = await call(port, 'OPTIONS', '/api/auth/refresh', {
          Origin: origin, 'Access-Control-Request-Method': 'POST',
        });
        assert.equal(preflight.headers['access-control-allow-origin'], undefined);
        const post = await call(port, 'POST', '/api/auth/refresh', { Origin: origin });
        assert.equal(post.status, 403);
        assert.equal(post.headers['access-control-allow-origin'], undefined);
      }
      assert.equal(rateChecks, previousChecks, 'Untrusted session requests must stop before persistence');
    });

    await t.test('explicit additional origins and a trailing-slash frontend URL use the same auth allowlist', async () => {
      process.env.FRONTEND_URL = 'https://custom.example.test/';
      process.env.CORS_ALLOWED_ORIGINS = ' https://preview.example.test/ , https://another.example.test ';
      for (const origin of ['https://custom.example.test', 'https://preview.example.test', ...allowed]) {
        const result = await call(port, 'POST', '/api/auth/refresh', { Origin: origin });
        assert.equal(result.status, 401);
        assert.equal(result.headers['access-control-allow-origin'], origin);
      }
    });

    await t.test('configured localhost development requests still work', async () => {
      process.env.NODE_ENV = 'development';
      process.env.FRONTEND_URL = 'http://localhost:3000/';
      delete process.env.CORS_ALLOWED_ORIGINS;
      const result = await call(port, 'POST', '/api/auth/refresh', { Origin: 'http://localhost:3000' });
      assert.equal(result.status, 401);
      assert.equal(result.headers['access-control-allow-origin'], 'http://localhost:3000');
      assert.equal(result.headers['access-control-allow-credentials'], 'true');
    });

    await t.test('no-origin CLI calls work while browser cross-site metadata cannot bypass the guard', async () => {
      const get = await call(port, 'GET', '/');
      assert.equal(get.status, 200);
      assert.equal(get.headers['access-control-allow-origin'], undefined);
      const cli = await call(port, 'POST', '/api/auth/refresh');
      assert.equal(cli.status, 401);
      const browser = await call(port, 'POST', '/api/auth/refresh', { 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(browser.status, 403);
    });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    prisma.$queryRawUnsafe = previousQuery;
    prisma.$executeRawUnsafe = previousExecute;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
