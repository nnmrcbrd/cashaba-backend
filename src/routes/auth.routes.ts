import { Router, type RequestHandler } from 'express';
import {
  changePassword,
  forgotPassword,
  signup,
  verifyEmail,
  verifyEmailCode,
  resendVerification,
  verifyResetCode,
  login,
  refresh,
  logout,
  resetPassword,
  startGoogleOAuth,
  finishGoogleOAuth,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { rateLimit } from '../middlewares/rateLimit.middleware';

import { protectCookieMutation } from '../middlewares/csrf.middleware';
import { assertOtpMailConfigured } from '../services/mail';

const router = Router();
const credentialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
// A missing mail service is a server setup failure, not a recovery attempt.
// Check it before consuming the IP quota so setup retries cannot lock users out.
const requireEmailDelivery: RequestHandler = (_req, res, next) => {
  try { assertOtpMailConfigured(); }
  catch { res.status(503).json({ message: 'Email delivery is currently unavailable. Please try again later.' }); return; }
  next();
};

router.post('/signup', protectCookieMutation, requireEmailDelivery, recoveryLimiter, signup);
router.get('/verify', verifyEmail); // Existing emailed links remain usable until expiry.
router.post('/verify', credentialLimiter, verifyEmailCode);
router.post('/resend-verification', requireEmailDelivery, recoveryLimiter, resendVerification);
router.post('/verify-reset-code', credentialLimiter, verifyResetCode);
router.post('/login', credentialLimiter, login);
router.get('/google', credentialLimiter, startGoogleOAuth);
router.get('/google/callback', credentialLimiter, finishGoogleOAuth);
router.post('/refresh', protectCookieMutation, rateLimit({ windowMs: 60_000, max: 60 }), refresh);
router.post('/logout', protectCookieMutation, rateLimit({ windowMs: 60_000, max: 30 }), logout);
router.post('/forgot-password', requireEmailDelivery, recoveryLimiter, forgotPassword);
router.post('/reset-password', credentialLimiter, resetPassword);
router.post('/change-password', authenticate, changePassword);
export default router;
