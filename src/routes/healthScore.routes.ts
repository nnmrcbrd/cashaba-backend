import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { getHealthScore } from "@/controllers/healthScore.controller";

const router = Router();

// GET /api/user/health-score — financial health score
router.get("/health-score", authenticate, getHealthScore);

export default router;
