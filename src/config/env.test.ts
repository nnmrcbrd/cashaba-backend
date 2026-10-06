import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionConfig } from './env';

test('production validates disabled, live recurring and test-only hosted checkout modes', () => {
  const names = ['NODE_ENV', 'DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FRONTEND_URL', 'BACKEND_URL', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM', 'BILLING_MODE', 'BILLING_WEBHOOK_SECRET', 'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET'] as const;
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'test-value';
    process.env.NODE_ENV = 'production';
    process.env.BILLING_MODE = 'webhook';
    assert.throws(assertProductionConfig, /BILLING_MODE/);
    process.env.BILLING_MODE = 'disabled';
    delete process.env.PAYMONGO_SECRET_KEY;
    delete process.env.PAYMONGO_WEBHOOK_SECRET;
    assert.doesNotThrow(assertProductionConfig);
    process.env.BILLING_MODE = 'paymongo_test';
    process.env.PAYMONGO_SECRET_KEY = 'sk_live_example';
    assert.throws(assertProductionConfig, /secret test key/);
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_example';
    delete process.env.PAYMONGO_WEBHOOK_SECRET;
    assert.doesNotThrow(assertProductionConfig);
    process.env.BILLING_MODE = 'paymongo';
    delete process.env.PAYMONGO_SECRET_KEY;
    assert.throws(assertProductionConfig, /PAYMONGO_SECRET_KEY/);
    process.env.PAYMONGO_SECRET_KEY = 'sk_test_example';
    process.env.PAYMONGO_WEBHOOK_SECRET = 'webhook-secret';
    assert.throws(assertProductionConfig, /live secret key/);
    process.env.PAYMONGO_SECRET_KEY = 'sk_live_example';
    assert.doesNotThrow(assertProductionConfig);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});
