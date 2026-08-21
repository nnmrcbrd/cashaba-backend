import { Router } from "express";
import { processAiChat, getAiHistory } from "@/controllers/aiCommand.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { suggestBudget } from "@/controllers/suggestBudget.controller";

const router = Router();

router.use(authenticate);

router.post("/chat", processAiChat);
router.get("/history", getAiHistory);

// Premium: AI budget suggestion based on income (50/30/20 rule)
router.post("/suggest-budget", suggestBudget);

export default router;
