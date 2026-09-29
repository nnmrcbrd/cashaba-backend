import { Router } from 'express';
import {
  changePassword,
  forgotPassword,
  signup,
  verifyEmail,
  login,
  refresh,
  logout,
  resetPassword,
  startGoogleOAuth,
  finishGoogleOAuth,
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { rateLimit } from '../middlewares/rateLimit.middleware';

const router = Router();
const credentialLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const recoveryLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });

router.post('/signup', recoveryLimiter, signup);
router.get('/verify', verifyEmail); // New route
router.post('/login', credentialLimiter, login);
router.get('/google', credentialLimiter, startGoogleOAuth);
router.get('/google/callback', credentialLimiter, finishGoogleOAuth);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/forgot-password', recoveryLimiter, forgotPassword);
router.post('/reset-password', recoveryLimiter, resetPassword);
router.post('/change-password', authenticate, changePassword);
export default router;
