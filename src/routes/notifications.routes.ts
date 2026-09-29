import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { getNotifications } from "@/controllers/notifications.controller";

const router = Router();

// GET /api/notifications — smart spending alerts for authenticated user
router.get("/", authenticate, authorize(["USER"]), getNotifications);

export default router;
