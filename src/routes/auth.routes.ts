import { Router } from 'express';
import { signup, verifyEmail, login, refresh, logout } from '../controllers/auth.controller';

const router = Router();

router.post('/signup', signup);
router.get('/verify', verifyEmail); // New route
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);
export default router;
