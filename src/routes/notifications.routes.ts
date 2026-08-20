import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { getNotifications } from "@/controllers/notifications.controller";

const router = Router();

// GET /api/notifications — smart spending alerts for authenticated user
router.get("/", authenticate, getNotifications);

export default router;
