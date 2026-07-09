import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import { generateVerificationToken } from '@/utils/token';

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
        roles: userData.roles || [],
        accountRole: 'USER',
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

  // 4. Generate JWT tokenss
  const accessToken = jwt.sign(
  { userId: user.id, accountRole: user.accountRole, roles: user.roles },
  process.env.JWT_ACCESS_SECRET as string, // Cast as string here
  { expiresIn: '15m' }                     // Now the overload will be correct
);

const refreshSecret = process.env.JWT_REFRESH_SECRET as string;
const refreshExpires = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

  const refreshTokenString = jwt.sign(
    { userId: user.id },
    refreshSecret,
  { expiresIn: refreshExpires } as jwt.SignOptions // Explicit cast fixes the overload error
);

  const tokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // 5. Save the long-lived refresh token in your Token database table
  await prisma.token.create({
    data: {
      token: refreshTokenString,
      type: 'REFRESH',
      expiresAt: tokenExpires,
      userId: user.id,
    },
  });

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