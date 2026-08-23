import { Router } from "express";
import {
  getLoans,
  createLoan,
  updateLoanStatus,
  deleteLoan,
  recordLoanRepayment,
} from "@/controllers/loan.controller";
import { authenticate } from "@/middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

router.get("/", getLoans);
router.post("/", createLoan);
router.patch("/:id/status", updateLoanStatus);
router.post("/:id/repayments", recordLoanRepayment);
router.delete("/:id", deleteLoan);

export default router;
