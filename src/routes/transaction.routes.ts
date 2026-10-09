import { requireProductAccess } from '@/middlewares/productAccess.middleware';
import { Router } from "express";
import {
    getTransactions,
    createTransaction,
    updateTransaction,
    deleteTransaction,
    undoLastTransaction,
} from "@/controllers/transaction.controller";
import { importGCashTransactions } from "@/controllers/gcash.controller";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import multer from "multer";
import { importBankCSV } from "@/controllers/bankImport.controller";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
});

const router = Router();

router.use(authenticate, authorize(["USER"]), requireProductAccess);

router.get("/", getTransactions);
router.post("/", createTransaction);
router.post("/undo", undoLastTransaction);
router.put("/:id", updateTransaction);
router.delete("/:id", deleteTransaction);

router.post(
    "/import-gcash",
    upload.single("file"),
    importGCashTransactions
);

// Bulk CSV import (BDO, BPI, GCash, UnionBank)
router.post("/import-csv", importBankCSV);

export default router;
