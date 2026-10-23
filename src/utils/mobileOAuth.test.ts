import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createMobileOAuthState, isMobileCodeChallenge, mobileHandoffFingerprint, mobileProofChallenge, readMobileOAuthChallenge } from './mobileOAuth';

test('mobile Google PKCE uses the RFC 7636 S256 proof and validates input', () => {
  const challenge = mobileProofChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(isMobileCodeChallenge(challenge), true);
  for (const value of [null, '', 'a'.repeat(42), 'a'.repeat(44), '.'.repeat(43)]) assert.equal(isMobileCodeChallenge(value), false);
  for (const value of [null, '', 'x'.repeat(42), 'x'.repeat(129), '!'.repeat(43)]) assert.throws(() => mobileProofChallenge(value));
  assert.notEqual(mobileHandoffFingerprint('code', challenge), mobileHandoffFingerprint('code', 'other-challenge'));
});

test('mobile OAuth state is signed, expires and cannot be confused with the web flow', () => {
  const oldSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = 'mobile-oauth-state-synthetic-test-secret';
  try {
    const challenge = mobileProofChallenge('a'.repeat(43));
    const state = createMobileOAuthState(challenge);
    assert.equal(readMobileOAuthChallenge(state), challenge);
    assert.equal(readMobileOAuthChallenge('web-oauth-random-state'), null);
    assert.notEqual(createMobileOAuthState(challenge), state);
    const parts = state.split('.');
    parts[3] = (parts[3][0] === 'a' ? 'b' : 'a') + parts[3].slice(1);
    assert.throws(() => readMobileOAuthChallenge(parts.join('.')));
    const expired = jwt.sign({ challenge }, process.env.JWT_ACCESS_SECRET, { audience: 'cashaba-android-google', expiresIn: -1 });
    assert.throws(() => readMobileOAuthChallenge(`android.${expired}`));
    const wrongAudience = jwt.sign({ challenge }, process.env.JWT_ACCESS_SECRET, { audience: 'another-app', expiresIn: '10m' });
    assert.throws(() => readMobileOAuthChallenge(`android.${wrongAudience}`));
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = oldSecret;
  }
});
