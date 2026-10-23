import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const MOBILE_GOOGLE_CALLBACK = 'cashaba://auth/google/callback';
const audience = 'cashaba-android-google';

function oauthSecret() {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('Mobile Google sign-in is not configured.');
  return secret;
}

export function isMobileCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function mobileProofChallenge(verifier: unknown): string {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    throw new Error('Invalid mobile sign-in proof.');
  }
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createMobileOAuthState(challenge: string): string {
  if (!isMobileCodeChallenge(challenge)) throw new Error('Invalid mobile sign-in challenge.');
  return `android.${jwt.sign({ challenge, nonce: randomBytes(32).toString('base64url') }, oauthSecret(), {
    algorithm: 'HS256', audience, expiresIn: '10m',
  })}`;
}

export function readMobileOAuthChallenge(state: unknown): string | null {
  if (typeof state !== 'string' || !state.startsWith('android.')) return null;
  const payload = jwt.verify(state.slice('android.'.length), oauthSecret(), {
    algorithms: ['HS256'], audience,
  });
  if (typeof payload === 'string' || !isMobileCodeChallenge(payload.challenge)) {
    throw new Error('Invalid mobile sign-in state.');
  }
  return payload.challenge;
}

// A handoff is a short-lived refresh grant, namespaced away from web refresh
// token fingerprints. It can only be redeemed with the original PKCE verifier.
export function mobileHandoffFingerprint(code: string, challenge: string): string {
  return createHash('sha256').update(`cashaba-mobile-google:${code}:${challenge}`).digest('hex');
}

export function mobileGoogleResultUrl(result: { code?: string; error?: string }): string {
  const url = new URL(MOBILE_GOOGLE_CALLBACK);
  if (result.code) url.searchParams.set('code', result.code);
  if (result.error) url.searchParams.set('error', result.error);
  return url.toString();
}
