import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import {
  getIncomeSetup,
  upsertIncomeSetup,
  getFixedExpenses,
  addFixedExpense,
  deleteFixedExpense,
  getSavingsGoals,
  addSavingsGoal,
  updateSavingsGoal,
  deleteSavingsGoal,
} from "@/controllers/incomeSetup.controller";

const router = Router();

router.use(authenticate);

// Income setup
router.get("/", getIncomeSetup);
router.post("/", upsertIncomeSetup);

// Fixed expenses
router.get("/fixed-expenses", getFixedExpenses);
router.post("/fixed-expenses", addFixedExpense);
router.delete("/fixed-expenses/:id", deleteFixedExpense);

// Savings goals
router.get("/savings-goals", getSavingsGoals);
router.post("/savings-goals", addSavingsGoal);
router.patch("/savings-goals/:id", updateSavingsGoal);
router.delete("/savings-goals/:id", deleteSavingsGoal);

export default router;
