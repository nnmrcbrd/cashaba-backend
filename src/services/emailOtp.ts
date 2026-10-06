import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { databaseRateLimit } from '@/middlewares/rateLimit.middleware';
import { FinancialError, type FinancialTx, withFinancialOperation } from './financialOperation';
import { assertOtpMailConfigured, sendAccountCode } from './mail';

export type OtpPurpose = 'VERIFICATION' | 'PASSWORD_RESET';
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export class EmailOtpRateLimitError extends FinancialError {
  readonly retryAfterSeconds: number;
  constructor(message: string, resetAt: number) {
    super(message, 429);
    this.retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  }
}
export function generateEmailCode() { return randomInt(0, 1_000_000).toString().padStart(6, '0'); }
export function otpFingerprint(challengeId: string, purpose: OtpPurpose, code: string) {
  const secret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new FinancialError('Account verification is temporarily unavailable.', 503);
  return 'otp:' + createHmac('sha256', secret).update(`${purpose}:${challengeId}:${code}`).digest('hex');
}
const counterKey = (label: string) => createHash('sha256').update(label).digest('hex');

export async function requestEmailOtp(email: string, purpose: OtpPurpose) {
  assertOtpMailConfigured();
  const normalized = email.trim().toLowerCase();
  // Database counters also protect a mailbox across different IPs/replicas.
  const minute = await databaseRateLimit(counterKey(`otp-send-minute:${purpose}:${normalized}`), 60_000);
  if (minute.count > 1) throw new EmailOtpRateLimitError('Please wait one minute before requesting another code.', minute.resetAt);
  const hour = await databaseRateLimit(counterKey(`otp-send-hour:${purpose}:${normalized}`), 3_600_000);
  if (hour.count > 5) throw new EmailOtpRateLimitError('Too many code requests. Please try again later.', hour.resetAt);
  const challengeId = randomUUID();
  const user = await prisma.user.findUnique({ where: { email: normalized } });
  // Same opaque response for unknown/verified/suspended accounts; no OTP is
  // exposed in an API response, including local development.
  if (!user || user.accountStatus === 'SUSPENDED' || (purpose === 'VERIFICATION' && user.localCredentialVerified)) return { challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 };
  const code = generateEmailCode();
  const digest = otpFingerprint(challengeId, purpose, code);
  await withFinancialOperation(user.id, async tx => {
    await tx.token.updateMany({ where: { userId: user.id, type: purpose, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.token.create({ data: { id: challengeId, userId: user.id, type: purpose, token: digest, expiresAt: new Date(Date.now() + OTP_TTL_MS) } });
  });
  try { await sendAccountCode(user.email, code, purpose); }
  catch (error) {
    await prisma.token.update({ where: { id: challengeId }, data: { revokedAt: new Date() } });
    console.error('Account code delivery failed', error instanceof Error ? error.name : 'mail error');
    // Do not disclose account existence through a provider failure.
  }
  return { challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 };
}

export async function consumeEmailOtp<T>(challengeId: string, code: string, purpose: OtpPurpose, apply: (tx: FinancialTx, userId: string) => Promise<T>): Promise<T> {
  const invalid = () => new FinancialError('Invalid or expired code. Request a new code if needed.');
  if (!/^[a-f0-9-]{36}$/i.test(challengeId) || !/^\d{6}$/.test(code)) throw invalid();
  const token = await prisma.token.findUnique({ where: { id: challengeId } });
  if (!token || token.type !== purpose || !token.token.startsWith('otp:')) throw invalid();
  const attempts = await databaseRateLimit(counterKey(`otp-attempt:${purpose}:${challengeId}`), OTP_TTL_MS);
  const result = await withFinancialOperation(token.userId, async tx => {
    const current = await tx.token.findUniqueOrThrow({ where: { id: challengeId } });
    if (current.consumedAt || current.revokedAt || current.expiresAt <= new Date()) return { valid: false } as const;
    const expected = otpFingerprint(challengeId, purpose, code);
    const matches = current.token.length === expected.length && timingSafeEqual(Buffer.from(current.token), Buffer.from(expected));
    if (attempts.count > OTP_MAX_ATTEMPTS || !matches) {
      if (attempts.count >= OTP_MAX_ATTEMPTS) await tx.token.update({ where: { id: challengeId }, data: { revokedAt: new Date() } });
      return { valid: false } as const; // commit lockout before returning an error
    }
    const user = await tx.user.findUniqueOrThrow({ where: { id: token.userId } });
    if (user.accountStatus === 'SUSPENDED') return { valid: false } as const;
    await tx.token.update({ where: { id: challengeId }, data: { consumedAt: new Date() } });
    return { valid: true, value: await apply(tx, token.userId) } as const;
  });
  if (!result.valid) throw invalid();
  return result.value;
}
