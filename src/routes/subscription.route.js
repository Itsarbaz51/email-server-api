import express from "express";
import {
  verifyPayment,
  createOrRenewSubscription,
  getCurrentSubscription,
  cancelSubscription,
  createRazorpayOrder // Add this
} from "../controllers/subscription.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.route("/create-order").post(requireAuth, createRazorpayOrder);
router.route("/create-or-renew").post(requireAuth, createOrRenewSubscription);
router.route("/verify-payment").post(requireAuth, verifyPayment);
router.route("/current").get(requireAuth, getCurrentSubscription);
router.route("/cancel").delete(requireAuth, cancelSubscription);

export default router;