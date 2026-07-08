import { Router } from 'express';
import { signup, verifyEmail, login } from '../controllers/auth.controller';

const router = Router();

router.post('/signup', signup);
router.get('/verify', verifyEmail); // New route
router.post('/login', login);
export default router;