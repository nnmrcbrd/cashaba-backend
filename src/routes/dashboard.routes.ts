import { Router } from "express";

const router = Router();

router.get("/test", (req, res) => {
    res.send("Dashboard Test");
});

export default router;