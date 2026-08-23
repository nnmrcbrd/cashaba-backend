import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { prisma } from '@/lib/prisma';
import { authorize } from '@/middlewares/rbac.middleware';
import { z } from 'zod';

const profileUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  gender: z.string().trim().max(40).nullable().optional(),
  roles: z.array(z.enum(['STUDENT', 'WORKING', 'FREELANCE', 'MARRIED'])).min(1).max(4),
});

const router = Router();

// Current User Profile
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        gender: true,
        accountRole: true,
        roles: true,
        createdAt: true,
        incomeSetup: { select: { id: true } },
      }
    });

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json({ ...user, onboardingComplete: Boolean(user.incomeSetup), incomeSetup: undefined });
  } catch {
    res.status(500).json({ message: "Error fetching profile" });
  }
});

router.patch('/me', authenticate, async (req: Request, res: Response) => {
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid profile details', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: parsed.data,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        gender: true,
        accountRole: true,
        roles: true,
        createdAt: true,
        incomeSetup: { select: { id: true } },
      },
    });
    res.json({ ...user, onboardingComplete: Boolean(user.incomeSetup), incomeSetup: undefined });
  } catch {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

// ADMIN MANAGE USERS DASHBOARD ENDPOINT
router.get('/admin/manage-users', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  try {
    const dbUsers = await prisma.user.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        createdAt: true,
        accountRole: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const transactions = await prisma.transaction.findMany({
      select: { type: true, createdAt: true },
    });
    const txCount = transactions.length;
    
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTxCount = await prisma.transaction.count({
      where: { createdAt: { gte: startOfMonth } },
    });

    const mappedUsers = dbUsers.map((u) => {
      return {
        id: u.id,
        name: `${u.firstName} ${u.lastName}`.trim(),
        email: u.email,
        location: 'Not collected',
        joinedDate: new Date(u.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        status: 'Active',
      };
    });

    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const chartData = Array.from({ length: 4 }, (_, index) => {
      const bucketStart = new Date(now.getTime() - (3 - index) * weekMs);
      bucketStart.setHours(0, 0, 0, 0);
      const bucketEnd = new Date(bucketStart.getTime() + weekMs);
      const bucket = transactions.filter((transaction) => (
        transaction.createdAt >= bucketStart && transaction.createdAt < bucketEnd
      ));
      return {
        date: bucketStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        green: bucket.filter((transaction) => transaction.type === 'INCOME').length,
        gray: bucket.filter((transaction) => transaction.type === 'EXPENSE').length,
      };
    });

    const weekStart = new Date(now.getTime() - weekMs);
    const newUsersThisWeek = dbUsers.filter((user) => user.createdAt >= weekStart).length;
    const weekTransactions = transactions.filter((transaction) => transaction.createdAt >= weekStart).length;

    res.json({
      users: mappedUsers,
      metrics: {
        totalUsers: dbUsers.length,
        totalTransactions: txCount,
        monthTransactions: monthTxCount,
        activeUsers: dbUsers.length,
        newUsersThisWeek,
        weekTransactions,
      },
      locationBreakdown: [],
      chartData,
    });
  } catch (error) {
    console.error("Admin error:", error);
    res.status(500).json({ message: "Error fetching admin data" });
  }
});

// ADMIN TOGGLE USER STATUS
router.patch('/admin/users/:id/status', authenticate, authorize(['ADMIN']), async (req: Request, res: Response) => {
  res.status(501).json({
    message: 'Account activation status is not available until the approved database field is added.',
  });
});

export default router;
