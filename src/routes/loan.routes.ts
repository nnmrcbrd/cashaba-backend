import { Router } from "express";
import {
  getLoans,
  createLoan,
  updateLoanStatus,
  deleteLoan,
} from "@/controllers/loan.controller";
import { authenticate } from "@/middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

router.get("/", getLoans);
router.post("/", createLoan);
router.patch("/:id/status", updateLoanStatus);
router.delete("/:id", deleteLoan);

export default router;
