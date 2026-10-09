import { requireProductAccess } from '@/middlewares/productAccess.middleware';
import { Router } from "express";
import {
  getLoans,
  createLoan,
  updateLoanStatus,
  deleteLoan,
  recordLoanRepayment,
} from "@/controllers/loan.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";

const router = Router();

router.use(authenticate, authorize(["USER"]), requireProductAccess);

router.get("/", getLoans);
router.post("/", createLoan);
router.patch("/:id/status", updateLoanStatus);
router.post("/:id/repayments", recordLoanRepayment);
router.delete("/:id", deleteLoan);

export default router;
