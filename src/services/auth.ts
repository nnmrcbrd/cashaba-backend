import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { generateVerificationToken } from '@/utils/token';
import { createHash } from 'crypto';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function requiredSecret(name: 'JWT_ACCESS_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name] || process.env.JWT_SECRET;
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function createAccessToken(user: { id: string; accountRole: string; roles: string[] }): string {
  return jwt.sign(
    { userId: user.id, accountRole: user.accountRole, roles: user.roles },
    requiredSecret('JWT_ACCESS_SECRET'),
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

async function createRefreshToken(userId: string): Promise<string> {
  const refreshToken = jwt.sign(
    { userId },
    requiredSecret('JWT_REFRESH_SECRET'),
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' } as jwt.SignOptions,
  );

  await prisma.token.create({
    data: {
      token: tokenFingerprint(refreshToken),
      type: 'REFRESH',
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userId,
    },
  });

  return refreshToken;
}

interface RegistrationData {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  gender?: string;
  role?: Array<'STUDENT' | 'WORKING' | 'FREELANCE' | 'MARRIED'>;
}

export const registerUser = async (userData: RegistrationData) => {
  const existingUser = await prisma.user.findUnique({ where: { email: userData.email } });
  if (existingUser) {
    throw new Error('Email is already registered');
  }

  const hashedPassword = await bcrypt.hash(userData.password, 10);
  const newUser = await prisma.user.create({
    data: {
      firstName: userData.firstName,
      lastName: userData.lastName,
      email: userData.email,
      password: hashedPassword,
      gender: userData.gender,
      roles: userData.role || [],
      accountRole: 'USER',
      // Email delivery is not configured in the current capstone environment.
      emailVerified: new Date(),
    },
  });

  return newUser;
};

export const verifyUserEmail = async (tokenString: string) => {
  // 1. Find the token and include the user
  const tokenRecord = await prisma.token.findUnique({
    where: { token: tokenString },
    include: { user: true },
  });

  // 2. Validation Checks
  if (!tokenRecord || tokenRecord.type !== 'VERIFICATION') {
    throw new Error('Invalid verification token');
  }

  if (tokenRecord.expiresAt < new Date()) {
    throw new Error('Verification token has expired');
  }

  // NEW: Check if token was already used or manually revoked
  if (tokenRecord.consumedAt) {
    throw new Error('This email has already been verified');
  }

  if (tokenRecord.revokedAt) {
    throw new Error('This token has been revoked');
  }

  // 3. Update user and mark token as consumed
  await prisma.$transaction([
    prisma.user.update({
      where: { id: tokenRecord.userId },
      data: { emailVerified: new Date() },
    }),
    prisma.token.update({
      where: { id: tokenRecord.id },
      data: { consumedAt: new Date() }, // We timestamp it instead of deleting
    }),
  ]);

  return { message: 'Email verified successfully' };
};

export const loginUser = async (loginData: any) => {
  // 1. Verify existence
  const user = await prisma.user.findUnique({
    where: { email: loginData.email },
    include: { incomeSetup: { select: { id: true } } },
  });
  if (!user) {
    throw new Error('Invalid email or password');
  }

  // 2. Validate password match
  const isPasswordMatch = await bcrypt.compare(loginData.password, user.password);
  if (!isPasswordMatch) {
    throw new Error('Invalid email or password');
  }

  // 3. Confirm activation standing
  if (!user.emailVerified) {
    throw new Error('Please verify your email address before logging in.');
  }

  const accessToken = createAccessToken(user);
  const refreshTokenString = await createRefreshToken(user.id);

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      accountRole: user.accountRole,
      gender: user.gender,
      roles: user.roles,
      createdAt: user.createdAt,
      onboardingComplete: Boolean(user.incomeSetup),
    },
    accessToken,
    refreshToken: refreshTokenString,
  };
};

export const refreshUserSession = async (refreshToken: string) => {
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(refreshToken, requiredSecret('JWT_REFRESH_SECRET')) as jwt.JwtPayload;
  } catch {
    throw new Error('Invalid or expired refresh token');
  }

  if (typeof decoded.userId !== 'string') throw new Error('Invalid refresh token');

  const storedToken = await prisma.token.findFirst({
    where: { token: { in: [tokenFingerprint(refreshToken), refreshToken] } },
  });
  if (
    !storedToken ||
    storedToken.type !== 'REFRESH' ||
    storedToken.userId !== decoded.userId ||
    storedToken.consumedAt ||
    storedToken.revokedAt ||
    storedToken.expiresAt <= new Date()
  ) {
    throw new Error('Refresh token is no longer active');
  }

  const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
  if (!user) throw new Error('User no longer exists');

  // Rotate refresh tokens so a stolen token cannot be reused indefinitely.
  await prisma.token.update({
    where: { id: storedToken.id },
    data: { consumedAt: new Date() },
  });

  return {
    accessToken: createAccessToken(user),
    refreshToken: await createRefreshToken(user.id),
  };
};

export const revokeUserSession = async (refreshToken?: string): Promise<void> => {
  if (!refreshToken) return;
  await prisma.token.updateMany({
    where: {
      token: { in: [tokenFingerprint(refreshToken), refreshToken] },
      type: 'REFRESH',
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
};

export const changeUserPassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
    throw new Error('Current password is incorrect');
  }

  const password = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { password } }),
    prisma.token.updateMany({
      where: { userId, type: 'REFRESH', revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
};

export const requestPasswordReset = async (email: string): Promise<string | null> => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;

  const rawToken = generateVerificationToken();
  await prisma.token.create({
    data: {
      token: tokenFingerprint(rawToken),
      type: 'PASSWORD_RESET',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      userId: user.id,
    },
  });
  return rawToken;
};

export const resetUserPassword = async (rawToken: string, newPassword: string): Promise<void> => {
  const token = await prisma.token.findFirst({
    where: {
      token: { in: [tokenFingerprint(rawToken), rawToken] },
      type: 'PASSWORD_RESET',
    },
  });
  if (!token || token.expiresAt <= new Date() || token.consumedAt || token.revokedAt) {
    throw new Error('Invalid or expired password reset token');
  }

  const password = await bcrypt.hash(newPassword, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: token.userId }, data: { password } }),
    prisma.token.update({ where: { id: token.id }, data: { consumedAt: new Date() } }),
    prisma.token.updateMany({
      where: { userId: token.userId, type: 'REFRESH', revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
};
