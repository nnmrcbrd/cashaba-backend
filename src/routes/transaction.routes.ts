import { Router } from "express";
import {
    getTransactions,
    createTransaction,
    updateTransaction,
    deleteTransaction,
} from "@/controllers/transaction.controller";
import { authMiddleware } from "@/middlewares/auth.middleware";

const router = Router();

router.use(authMiddleware);

router.get("/", getTransactions);
router.post("/", createTransaction);
router.put("/:id", updateTransaction);
router.delete("/:id", deleteTransaction);

export default router;
