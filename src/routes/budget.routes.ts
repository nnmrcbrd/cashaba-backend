import { requireProductAccess } from '@/middlewares/productAccess.middleware';
import { Router } from "express";
import { copyPreviousBudget, getBudgets, updateBudget } from "@/controllers/budget.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";

const router = Router();

router.use(authenticate, authorize(["USER"]), requireProductAccess);

router.get("/", getBudgets);
router.put("/", updateBudget);
router.post("/copy-previous", copyPreviousBudget);

export default router;
