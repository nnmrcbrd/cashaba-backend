import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { normalizeGoogleName, type GoogleUserProfile } from '@/utils/googleProfile';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withFinancialOperation, type FinancialTx } from './financialOperation';
import { assertOtpMailConfigured } from './mail';
import { requestEmailOtp, consumeEmailOtp, OTP_TTL_MS } from './emailOtp';
import { isMobileCodeChallenge, mobileHandoffFingerprint, mobileProofChallenge } from '@/utils/mobileOAuth';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export type AuthMethod = 'LOCAL' | 'GOOGLE';
export function tokenFingerprint(token: string) { return createHash('sha256').update(token).digest('hex'); }
function requiredSecret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET') {
  const value = process.env[name] || process.env.JWT_SECRET;
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
type SessionUser = { id: string; accountRole: string; roles: string[]; sessionVersion: number };
function createAccessToken(user: SessionUser, authMethod: AuthMethod) {
  return jwt.sign({ userId: user.id, accountRole: user.accountRole, roles: user.roles, authMethod, sessionVersion: user.sessionVersion }, requiredSecret('JWT_ACCESS_SECRET'), { expiresIn: ACCESS_TOKEN_TTL });
}
export function signRefreshToken(userId: string, authMethod: AuthMethod, sessionVersion: number, freshSignIn = false) {
  return jwt.sign({ userId, authMethod, sessionVersion,
    ...(authMethod === 'GOOGLE' && freshSignIn ? { freshSignIn: true } : {}),
  }, requiredSecret('JWT_REFRESH_SECRET'), { expiresIn: '7d', jwtid: randomUUID() });
}
async function createRefreshToken(tx: FinancialTx, user: SessionUser, authMethod: AuthMethod, freshSignIn = false) {
  const refreshToken = signRefreshToken(user.id, authMethod, user.sessionVersion, freshSignIn);
  await tx.token.create({ data: { token: tokenFingerprint(refreshToken), type: 'REFRESH', expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS), userId: user.id } });
  return refreshToken;
}
async function session(tx: FinancialTx, userId: string, authMethod: AuthMethod, freshSignIn = false) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.accountStatus === 'SUSPENDED') throw new Error('This account has been suspended. Contact an administrator.');
  await tx.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  return {
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, accountRole: user.accountRole, accountStatus: user.accountStatus, gender: user.gender, avatarUrl: user.avatarUrl, roles: user.roles, createdAt: user.createdAt, onboardingComplete: Boolean(user.onboardingCompletedAt), onboardingStep: user.onboardingStep, customRole: user.customRole, region: user.region, authMethod },
    accessToken: createAccessToken(user, authMethod), refreshToken: await createRefreshToken(tx, user, authMethod, freshSignIn),
  };
}
interface RegistrationData { firstName: string; lastName: string; email: string; password: string; gender?: string; role?: Array<'STUDENT' | 'WORKING' | 'FREELANCE' | 'MARRIED'> }
export async function registerUser(data: RegistrationData) {
  assertOtpMailConfigured();
  if (await prisma.user.findUnique({ where: { email: data.email } })) throw new Error('Email is already registered. Sign in or reset your password.');
  const password = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({ data: { firstName: data.firstName, lastName: data.lastName, email: data.email, password, gender: data.gender, roles: data.role || [], accountRole: 'USER', localCredentialVerified: false } });
  const verification = await requestEmailOtp(user.email, 'VERIFICATION');
  return { ...user, verification };
}
export async function verifyUserEmailCode(challengeId: string, code: string) {
  return consumeEmailOtp(challengeId, code, 'VERIFICATION', async (tx, userId) => {
    await tx.user.update({ where: { id: userId }, data: { emailVerified: new Date(), localCredentialVerified: true } });
    return { message: 'Email verified. You can now sign in.' };
  });
}
export async function verifyPasswordResetCode(challengeId: string, code: string) {
  return consumeEmailOtp(challengeId, code, 'PASSWORD_RESET', async (tx, userId) => {
    const resetToken = randomBytes(32).toString('hex');
    await tx.token.create({ data: { userId, type: 'PASSWORD_RESET', token: tokenFingerprint(resetToken), expiresAt: new Date(Date.now() + OTP_TTL_MS) } });
    return { resetToken };
  });
}
export async function verifyUserEmail(raw: string) {
  const token = await prisma.token.findUnique({ where: { token: tokenFingerprint(raw) } });
  if (!token || token.type !== 'VERIFICATION') throw new Error('Invalid verification token');
  return withFinancialOperation(token.userId, async tx => {
    const claimed = await tx.token.updateMany({ where: { id: token.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (!claimed.count) throw new Error('Invalid or expired verification token');
    await tx.user.update({ where: { id: token.userId }, data: { emailVerified: new Date(), localCredentialVerified: true } });
    return { message: 'Email verified. You can now sign in.' };
  });
}
export async function loginUser(data: { email: string; password: string }) {
  const user = await prisma.user.findUnique({ where: { email: data.email } });
  if (!user) throw new Error('Invalid email or password');
  return withFinancialOperation(user.id, async tx => {
    const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!await bcrypt.compare(data.password, current.password)) throw new Error('Invalid email or password');
    if (!current.localCredentialVerified) throw new Error('Please verify your email address before logging in.');
    return session(tx, user.id, 'LOCAL');
  });
}
export async function loginWithGoogle(profile: GoogleUserProfile) {
  if (!profile.subject || !profile.email || !profile.emailVerified) throw new Error('Google did not provide a verified identity.');
  const email = profile.email.trim().toLowerCase();
  const name = normalizeGoogleName(profile);
  let user = await prisma.user.findUnique({ where: { googleSubject: profile.subject } });
  if (!user) user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    try { user = await prisma.user.create({ data: { email, password: await bcrypt.hash(randomBytes(32).toString('hex'), 12), ...name, avatarUrl: profile.picture || null, roles: [], googleSubject: profile.subject, emailVerified: new Date() } }); }
    catch (error) {
      user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw error;
    }
  }
  return withFinancialOperation(user.id, async tx => {
    const current = await tx.user.findUniqueOrThrow({ where: { id: user!.id } });
    if (current.accountStatus === 'SUSPENDED') throw new Error('This account has been suspended. Contact an administrator.');
    if (current.googleSubject && current.googleSubject !== profile.subject) throw new Error('This email is linked to a different Google identity.');
    const firstLink = !current.googleSubject;
    // Legacy auto-verification cannot authorize retaining a local credential.
    // Invalidate both sessions and outstanding activation links when first linked.
    const discardUnverifiedPassword = firstLink && !current.localCredentialVerified;
    if (firstLink) await tx.token.updateMany({ where: { userId: current.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.user.update({ where: { id: current.id }, data: { googleSubject: profile.subject, ...name, avatarUrl: profile.picture || current.avatarUrl, emailVerified: new Date(), ...(firstLink ? { sessionVersion: { increment: 1 } } : {}), ...(discardUnverifiedPassword ? { password: await bcrypt.hash(randomBytes(32).toString('hex'), 12) } : {}) } });
    // Only a completed verified Google login starts a fresh idle window. The
    // signed one-use refresh token carries this marker across the redirect.
    return session(tx, current.id, 'GOOGLE', true);
  });
}
export async function refreshUserSession(refreshToken: string) {
  let decoded: jwt.JwtPayload;
  try { decoded = jwt.verify(refreshToken, requiredSecret('JWT_REFRESH_SECRET')) as jwt.JwtPayload; }
  catch { throw new Error('Invalid or expired refresh token'); }
  if (typeof decoded.userId !== 'string') throw new Error('Invalid refresh token');
  const userId = decoded.userId;
  return withFinancialOperation(userId, async tx => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (decoded.sessionVersion !== user.sessionVersion) throw new Error('Please sign in again');
    const claimed = await tx.token.updateMany({ where: { token: tokenFingerprint(refreshToken), userId, type: 'REFRESH', consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (!claimed.count) throw new Error('Refresh token is no longer active');
    const result = await session(tx, userId, decoded.authMethod === 'GOOGLE' ? 'GOOGLE' : 'LOCAL');
    // Rotation does not copy the marker, so later refreshes/reloads retain the
    // existing activity clock and cannot revive an expired idle session.
    const signInAge = typeof decoded.iat === 'number' ? Date.now() - decoded.iat * 1000 : Infinity;
    return { accessToken: result.accessToken, refreshToken: result.refreshToken,
      freshSignIn: decoded.authMethod === 'GOOGLE' && decoded.freshSignIn === true
        && signInAge >= 0 && signInAge < 15 * 60 * 1000 };
  });
}

export async function createMobileGoogleHandoff(refreshToken: string, challenge: string) {
  if (!isMobileCodeChallenge(challenge)) throw new Error('Invalid mobile sign-in challenge.');
  const decoded = jwt.verify(refreshToken, requiredSecret('JWT_REFRESH_SECRET')) as jwt.JwtPayload;
  if (typeof decoded.userId !== 'string' || decoded.authMethod !== 'GOOGLE' || decoded.freshSignIn !== true) {
    throw new Error('A fresh Google sign-in is required.');
  }
  return withFinancialOperation(decoded.userId, async tx => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: decoded.userId as string } });
    if (user.accountStatus === 'SUSPENDED' || user.sessionVersion !== decoded.sessionVersion) throw new Error('Please sign in again.');
    const claimed = await tx.token.updateMany({
      where: { token: tokenFingerprint(refreshToken), userId: user.id, type: 'REFRESH', consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (!claimed.count) throw new Error('Google sign-in is no longer active.');
    const code = randomBytes(32).toString('base64url');
    await tx.token.create({ data: {
      userId: user.id, type: 'REFRESH', token: mobileHandoffFingerprint(code, challenge),
      expiresAt: new Date(Date.now() + 90_000),
    } });
    return code;
  });
}

export async function exchangeMobileGoogleHandoff(code: unknown, verifier: unknown) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid mobile sign-in code.');
  const fingerprint = mobileHandoffFingerprint(code, mobileProofChallenge(verifier));
  const grant = await prisma.token.findUnique({ where: { token: fingerprint } });
  if (!grant || grant.type !== 'REFRESH') throw new Error('Mobile sign-in expired. Please try again.');
  return withFinancialOperation(grant.userId, async tx => {
    const claimed = await tx.token.updateMany({
      where: { id: grant.id, userId: grant.userId, type: 'REFRESH', consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (!claimed.count) throw new Error('Mobile sign-in expired. Please try again.');
    return session(tx, grant.userId, 'GOOGLE');
  });
}
export async function revokeUserSession(refreshToken?: string) {
  if (!refreshToken) return;
  await prisma.token.updateMany({ where: { token: { in: [tokenFingerprint(refreshToken), refreshToken] }, type: 'REFRESH', revokedAt: null }, data: { revokedAt: new Date() } });
}
async function replacePassword(tx: FinancialTx, userId: string, password: string) {
  await tx.user.update({ where: { id: userId }, data: { password, emailVerified: new Date(), localCredentialVerified: true, sessionVersion: { increment: 1 } } });
  await tx.token.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
export async function changeUserPassword(userId: string, currentPassword: string | undefined, newPassword: string, authMethod: AuthMethod) {
  await withFinancialOperation(userId, async tx => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (authMethod !== 'GOOGLE' && (!currentPassword || !await bcrypt.compare(currentPassword, user.password))) throw new Error('Current password is incorrect');
    if (await bcrypt.compare(newPassword, user.password)) throw new Error('New password must be different from your current password');
    await replacePassword(tx, userId, await bcrypt.hash(newPassword, 12));
    return true;
  });
}
export async function resetUserPassword(rawToken: string, newPassword: string) {
  const token = await prisma.token.findUnique({ where: { token: tokenFingerprint(rawToken) } });
  if (!token || token.type !== 'PASSWORD_RESET') throw new Error('Invalid or expired password reset token');
  const password = await bcrypt.hash(newPassword, 12);
  await withFinancialOperation(token.userId, async tx => {
    const claimed = await tx.token.updateMany({ where: { id: token.id, consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (!claimed.count) throw new Error('Invalid or expired password reset token');
    await replacePassword(tx, token.userId, password);
    return true;
  });
}
