import { Router } from "express";
import { checkRateLimit } from "../controllers/rateLimitController";

const router = Router();
router.get("/check", checkRateLimit);

export default router;
