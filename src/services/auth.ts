import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { generateVerificationToken } from '@/utils/token';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
      token: refreshToken,
      type: 'REFRESH',
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userId,
    },
  });

  return refreshToken;
}

export const registerUser = async (userData: any) => {
  const existingUser = await prisma.user.findUnique({ where: { email: userData.email } });
  if (existingUser) {
    throw new Error('Email is already registered');
  }

  const hashedPassword = await bcrypt.hash(userData.password, 10);
  const tokenString = generateVerificationToken();
  const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); 

  const newUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        firstName: userData.firstName,
        lastName: userData.lastName,
        email: userData.email,
        password: hashedPassword,
        gender: userData.gender,
        roles: userData.role || [],
        accountRole: 'USER',
        emailVerified: new Date(),
      },
    });

    await tx.token.create({
      data: {
        token: tokenString,
        type: 'VERIFICATION',
        expiresAt: tokenExpires,
        userId: user.id,
      },
    });

    return user;
  });

  console.log(`\n--- EMAIL MOCK ---`);
  console.log(`To: ${newUser.email}`);
  console.log(`Subject: Verify your Casha-Ba Account`);
  console.log(`Link: http://localhost:8000/api/auth/verify?token=${tokenString}`);
  console.log(`------------------\n`);

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
  const user = await prisma.user.findUnique({ where: { email: loginData.email } });
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

  const storedToken = await prisma.token.findUnique({ where: { token: refreshToken } });
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
    where: { token: refreshToken, type: 'REFRESH', revokedAt: null },
    data: { revokedAt: new Date() },
  });
};
