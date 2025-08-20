import express from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import {
  verifyPayment,
  createOrRenewSubscription,
  getMySubscription,
  cancelSubscription,
} from "../controllers/subscription.controller.js";

const router = express.Router();

router.use(requireAuth);

router.post("/verify-payment", verifyPayment);
router.post("/create-or-renew", createOrRenewSubscription);
router.get("/current", getMySubscription);
router.delete("/cancel", cancelSubscription);

export default router;
