import { Router, Request, Response } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { prisma } from '@/lib/prisma';
import { authorize } from '@/middlewares/rbac.middleware';

const router = Router();

// This route is protected
// Inside src/routes/user.routes.ts
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    // 1. Get userId from the authenticated middleware
    const userId = (req as any).user.userId;

    // 2. Fetch fresh data from the DB
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        accountRole: true,
        // (Do not select password!)
      }
    });

    if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: "Error fetching profile" });
  }
});

router.get('/profile', authenticate, (req, res) => {
  res.json({ message: 'Hello, you are logged in!' });
});

// 2. ADMIN ONLY ROUTE
router.get('/admin/dashboard', authenticate, authorize(['ADMIN']), (req, res) => {
  res.json({ message: 'Welcome, Admin!' });
});

// 3. MULTI-ROLE ROUTE (Example: Admin and Freelancer can access)
router.post('/jobs/post', authenticate, authorize(['ADMIN', 'FREELANCE']), (req, res) => {
  res.json({ message: 'Post created successfully!' });
});

// Only users who are either STUDENTS or WORKING can access this
router.get('/loan-application', 
  authenticate, 
  authorize(['STUDENT', 'WORKING']), 
  (req, res) => {
    res.json({ message: 'Welcome to the loan application page' });
});

export default router;