import { Router } from "express";
import { getBudgets, updateBudget } from "@/controllers/budget.controller";
import { authenticate } from "@/middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

router.get("/", getBudgets);
router.put("/", updateBudget);

export default router;
