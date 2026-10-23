import type { Request, Response } from 'express';
import { prisma } from '@/lib/prisma';

export const getAllUsers = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ message: 'Authentication required.' });
    return;
  }

  if (req.user.accountRole !== 'ADMIN') {
    res.status(403).json({ message: 'You do not have permission to perform this action.' });
    return;
  }

  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        accountRole: true,
        accountStatus: true,
        createdAt: true,
        lastActiveAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
};

export default getAllUsers;
