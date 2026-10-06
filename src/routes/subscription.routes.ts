import { Router } from 'express';
import { authenticate } from '@/middlewares/auth.middleware';
import { authorize } from '@/middlewares/rbac.middleware';
import { rateLimit } from '@/middlewares/rateLimit.middleware';
import { activateDemoPlus, billingWebhook, cancelSubscription, getMySubscription, startPayMongoSubscription, startPayMongoTestCheckout, verifyPayMongoTestCheckout } from '@/controllers/subscription.controller';

const router = Router();
router.post('/webhook', rateLimit({ windowMs: 60_000, max: 120 }), billingWebhook);
router.use(authenticate, authorize(['USER']));
router.get('/me', getMySubscription);
router.post('/paymongo/test/checkout', rateLimit({ windowMs: 60_000, max: 5 }), startPayMongoTestCheckout);
router.post('/paymongo/test/verify', rateLimit({ windowMs: 60_000, max: 30 }), verifyPayMongoTestCheckout);
router.post('/paymongo/start', rateLimit({ windowMs: 60_000, max: 5 }), startPayMongoSubscription);
router.post('/demo/activate', rateLimit({ windowMs: 60_000, max: 10 }), activateDemoPlus);
router.post('/cancel', cancelSubscription);
export default router;
