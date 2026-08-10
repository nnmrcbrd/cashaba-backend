import { Router } from "express";
import { processAiChat, getAiHistory } from "@/controllers/ai.controller";
import { authenticate } from "@/middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

router.post("/chat", processAiChat);
router.get("/history", getAiHistory);

export default router;
