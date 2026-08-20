import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { getFinancialInsights } from "@/controllers/insights.controller";

const router = Router();

// GET /api/ai/insights — personalized AI insight cards
router.get("/", authenticate, getFinancialInsights);

export default router;
