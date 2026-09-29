import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { normalizeGoogleName, type GoogleUserProfile } from '@/utils/googleProfile';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withFinancialOperation, type FinancialTx } from './financialOperation';
import { assertMailConfigured, sendAccountLink } from './mail';

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
export function signRefreshToken(userId: string, authMethod: AuthMethod, sessionVersion: number) {
  return jwt.sign({ userId, authMethod, sessionVersion }, requiredSecret('JWT_REFRESH_SECRET'), { expiresIn: '7d', jwtid: randomUUID() });
}
async function createRefreshToken(tx: FinancialTx, user: SessionUser, authMethod: AuthMethod) {
  const refreshToken = signRefreshToken(user.id, authMethod, user.sessionVersion);
  await tx.token.create({ data: { token: tokenFingerprint(refreshToken), type: 'REFRESH', expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS), userId: user.id } });
  return refreshToken;
}
async function session(tx: FinancialTx, userId: string, authMethod: AuthMethod) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.accountStatus === 'SUSPENDED') throw new Error('This account has been suspended. Contact an administrator.');
  await tx.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  return {
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, accountRole: user.accountRole, accountStatus: user.accountStatus, gender: user.gender, avatarUrl: user.avatarUrl, roles: user.roles, createdAt: user.createdAt, onboardingComplete: Boolean(user.onboardingCompletedAt), onboardingStep: user.onboardingStep, customRole: user.customRole, region: user.region, authMethod },
    accessToken: createAccessToken(user, authMethod), refreshToken: await createRefreshToken(tx, user, authMethod),
  };
}
interface RegistrationData { firstName: string; lastName: string; email: string; password: string; gender?: string; role?: Array<'STUDENT' | 'WORKING' | 'FREELANCE' | 'MARRIED'> }
export async function registerUser(data: RegistrationData) {
  assertMailConfigured();
  if (await prisma.user.findUnique({ where: { email: data.email } })) throw new Error('Email is already registered. Sign in or reset your password.');
  const rawToken = randomBytes(32).toString('hex');
  const password = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({ data: { firstName: data.firstName, lastName: data.lastName, email: data.email, password, gender: data.gender, roles: data.role || [], accountRole: 'USER', localCredentialVerified: false, tokens: { create: { token: tokenFingerprint(rawToken), type: 'VERIFICATION', expiresAt: new Date(Date.now() + 3_600_000) } } } });
  try { await sendAccountLink(user.email, rawToken, 'verify'); }
  catch { throw new Error('Your account was created, but email delivery failed. Use password recovery to verify your email and choose a new password.'); }
  return user;
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
    return session(tx, current.id, 'GOOGLE');
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
    return { accessToken: result.accessToken, refreshToken: result.refreshToken };
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
export async function requestPasswordReset(email: string): Promise<string | null> {
  assertMailConfigured();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;
  const rawToken = randomBytes(32).toString('hex');
  const record = await prisma.token.create({ data: { userId: user.id, token: tokenFingerprint(rawToken), type: 'PASSWORD_RESET', expiresAt: new Date(Date.now() + 3_600_000) } });
  try { await sendAccountLink(email, rawToken, 'reset'); }
  catch (error) {
    await prisma.token.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    console.error('Account recovery delivery failed', error instanceof Error ? error.name : 'mail error');
    // Same public response for existing and unknown addresses.
  }
  return process.env.NODE_ENV !== 'production' && !process.env.SMTP_HOST ? rawToken : null;
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
