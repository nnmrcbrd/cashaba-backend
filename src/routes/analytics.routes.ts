import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { getAnalytics } from "@/controllers/analytics.controller";

const router = Router();
router.get("/", authenticate, authorize(["USER"]), getAnalytics);
export default router;
