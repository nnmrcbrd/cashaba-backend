import { Router } from "express";
import { processAiChat, getAiHistory } from "@/controllers/aiCommand.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { suggestBudget } from "@/controllers/suggestBudget.controller";
import { rateLimit } from '@/middlewares/rateLimit.middleware';

const router = Router();

router.use(authenticate, authorize(["USER"]));
router.use(rateLimit({ windowMs: 60_000, max: 30 }));

router.post("/chat", processAiChat);
router.get("/history", getAiHistory);

// AI budget suggestion based on income (50/30/20 rule)
router.post("/suggest-budget", suggestBudget);

export default router;
