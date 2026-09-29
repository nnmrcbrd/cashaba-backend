import { Router } from "express";
import { authenticate } from "@/middlewares/auth.middleware";
import { authorize } from "@/middlewares/rbac.middleware";
import { getWallets, createWallet, updateWallet, deleteWallet } from "@/controllers/wallet.controller";

const router = Router();

router.use(authenticate, authorize(["USER"]));

router.get("/", getWallets);
router.post("/", createWallet);
router.put("/:id", updateWallet);
router.delete("/:id", deleteWallet);

export default router;
