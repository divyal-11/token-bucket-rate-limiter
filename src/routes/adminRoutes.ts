import { Router } from "express";
import { updateLimits } from "../controllers/adminController";

const router = Router();
router.post("/admin/limits", updateLimits);

export default router;
