import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { detectRecurring } from "@/controllers/recurring.controller";

const router = Router();

// GET /api/transactions/recurring — detect recurring expense patterns
router.get("/recurring", authenticate, detectRecurring);

export default router;
