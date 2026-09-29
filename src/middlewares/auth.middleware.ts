import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma';

interface AuthenticatedUser {
  userId: string;
  accountRole: string;
  roles: string[];
  id: string;
  authMethod: 'LOCAL' | 'GOOGLE';
}

// Extend the Request interface so TypeScript knows about 'user'
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Access denied. No token provided.' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const jwtSecret = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
    if (!jwtSecret) {
      res.status(500).json({ message: 'Authentication is not configured.' });
      return;
    }
    const decoded = jwt.verify(token, jwtSecret);
    if (
      typeof decoded === 'string' ||
      typeof decoded.userId !== 'string' ||
      typeof decoded.accountRole !== 'string' ||
      !Array.isArray(decoded.roles)
    ) {
      res.status(401).json({ message: 'Invalid access token payload.' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { id: true, accountRole: true, accountStatus: true, roles: true, sessionVersion: true } });
    if (!user || user.accountStatus === 'SUSPENDED') {
      res.status(401).json({ message: user ? 'This account has been suspended.' : 'Account no longer exists.' });
      return;
    }
    if (decoded.sessionVersion !== user.sessionVersion) {
      res.status(401).json({ message: 'Session revoked. Please sign in again.' });
      return;
    }
    req.user = {
      userId: decoded.userId,
      id: decoded.userId,
      accountRole: user.accountRole,
      roles: user.roles,
      authMethod: decoded.authMethod === 'GOOGLE' ? 'GOOGLE' : 'LOCAL',
    };
    next(); // Pass control to the next function
  } catch {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
};
