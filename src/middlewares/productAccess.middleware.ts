import type { Request, Response, NextFunction } from 'express';
import { getProductAccess } from '@/services/subscription';

// Existing records, reports and chat history stay readable after expiry.
// Apply only to financial routers, never to sign-in, billing or account deletion.
export async function requireProductAccess(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  try {
    const access = await getProductAccess(req.user!.userId);
    if (!access.canWrite) return res.status(402).json({
      code: 'TRIAL_EXPIRED', message: 'Your 14-day trial has ended. Choose Basic, Standard or Premium to add or edit records, use the AI assistant or scan receipts. You can still view and export your records.',
      subscriptionUrl: '/subscription', trialEndsAt: access.trialEndsAt,
    });
    next();
  } catch (error) { next(error); }
}
