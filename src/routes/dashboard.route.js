import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { getDashboardData } from "../controllers/admin.dashboard.js";

const router = Router();

router.use(requireAuth);

router.get("/get-dashboard-data", getDashboardData);

export default router;
