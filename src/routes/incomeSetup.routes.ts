import { requireProductAccess } from '@/middlewares/productAccess.middleware';
import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import {
  getIncomeSetup,
  upsertIncomeSetup,
  getFixedExpenses,
  addFixedExpense,
  updateFixedExpense,
  deleteFixedExpense,
  getSavingsGoals,
  addSavingsGoal,
  updateSavingsGoal,
  deleteSavingsGoal,
} from "@/controllers/incomeSetup.controller";

const router = Router();

router.use(authenticate, authorize(["USER"]), requireProductAccess);

// Income setup
router.get("/", getIncomeSetup);
router.post("/", upsertIncomeSetup);

// Fixed expenses
router.get("/fixed-expenses", getFixedExpenses);
router.post("/fixed-expenses", addFixedExpense);
router.patch("/fixed-expenses/:id", updateFixedExpense);
router.delete("/fixed-expenses/:id", deleteFixedExpense);

// Savings goals
router.get("/savings-goals", getSavingsGoals);
router.post("/savings-goals", addSavingsGoal);
router.patch("/savings-goals/:id", updateSavingsGoal);
router.delete("/savings-goals/:id", deleteSavingsGoal);

export default router;
