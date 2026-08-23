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
} from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.post('/signup', signup);
router.get('/verify', verifyEmail); // New route
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/change-password', authenticate, changePassword);
export default router;
