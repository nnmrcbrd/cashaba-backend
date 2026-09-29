import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { getFinancialInsights } from "@/controllers/insights.controller";

const router = Router();

// GET /api/ai/insights — personalized AI insight cards
router.get("/", authenticate, authorize(["USER"]), getFinancialInsights);

export default router;
