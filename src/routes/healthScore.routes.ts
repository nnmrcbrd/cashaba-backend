import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { getHealthScore } from "@/controllers/healthScore.controller";

const router = Router();

// GET /api/user/health-score — financial health score
router.get("/health-score", authenticate, authorize(["USER"]), getHealthScore);

export default router;
