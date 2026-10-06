import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateEmailCode, otpFingerprint } from './emailOtp';
import { emailOtpSchema } from '@/schema/auth';

test('OTP codes keep all six digits and reject malformed input', () => {
  for (let index = 0; index < 20; index++) assert.match(generateEmailCode(), /^\d{6}$/);
  assert.equal(emailOtpSchema.safeParse({ challengeId: randomUUID(), code: '012345' }).success, true);
  for (const code of ['12345', '1234567', 'ABC123', 123456]) assert.equal(emailOtpSchema.safeParse({ challengeId: randomUUID(), code }).success, false);
});

test('stored OTP fingerprints are bound to the server secret, challenge and purpose', () => {
  const old = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = 'synthetic-unit-test-secret';
  try {
    const id = randomUUID();
    const digest = otpFingerprint(id, 'VERIFICATION', '012345');
    assert.match(digest, /^otp:[a-f0-9]{64}$/);
    assert.notEqual(digest, otpFingerprint(id, 'PASSWORD_RESET', '012345'));
    assert.notEqual(digest, otpFingerprint(randomUUID(), 'VERIFICATION', '012345'));
    assert.notEqual(digest, otpFingerprint(id, 'VERIFICATION', '012346'));
    process.env.JWT_ACCESS_SECRET = 'a-different-secret';
    assert.notEqual(digest, otpFingerprint(id, 'VERIFICATION', '012345'));
  } finally { if (old === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = old; }
});
