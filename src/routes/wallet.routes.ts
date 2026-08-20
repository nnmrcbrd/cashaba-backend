import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { getWallets, createWallet, deleteWallet } from "@/controllers/wallet.controller";

const router = Router();

router.use(authenticate);

router.get("/", getWallets);
router.post("/", createWallet);
router.delete("/:id", deleteWallet);

export default router;
