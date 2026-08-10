import { Router } from "express";
import {
    getTransactions,
    createTransaction,
    updateTransaction,
    deleteTransaction,
} from "@/controllers/transaction.controller";
import { importGCashTransactions } from "@/controllers/gcash.controller";
import { authenticate } from "@/middlewares/auth.middleware";;
import multer from "multer";

const upload = multer({
    storage: multer.memoryStorage(),
});

const router = Router();

router.use(authenticate);;

router.get("/", getTransactions);
router.post("/", createTransaction);
router.put("/:id", updateTransaction);
router.delete("/:id", deleteTransaction);

router.post(
    "/import-gcash",
    upload.single("file"),
    importGCashTransactions
);

export default router;
