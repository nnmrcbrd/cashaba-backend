import { requireProductAccess } from '@/middlewares/productAccess.middleware';
import { Router } from "express";
import { processAiChat, getAiHistory } from "@/controllers/aiCommand.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { suggestBudget } from "@/controllers/suggestBudget.controller";
import { rateLimit } from '@/middlewares/rateLimit.middleware';
import { aiRequestScope } from '@/services/aiRuntime';

const router = Router();

router.use(authenticate, authorize(["USER"]), requireProductAccess);
router.use(rateLimit({ windowMs: 60_000, max: 30, identity: 'user' }));

router.post("/chat", aiRequestScope, processAiChat);
router.get("/history", getAiHistory);

// AI budget suggestion based on income (50/30/20 rule)
router.post("/suggest-budget", suggestBudget);

export default router;
