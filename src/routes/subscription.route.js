import express from "express";
import {
  verifyPayment,
  createOrRenewSubscription,
  getCurrentSubscription,
  cancelSubscription,
  createRazorpayOrder,
  WebhookRazorpay,
  allSubscriptions,
} from "../controllers/subscription.controller.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.route("/create-order").post(requireAuth, createRazorpayOrder);
router.route("/create-or-renew").post(requireAuth, createOrRenewSubscription);
router.route("/verify-payment").post(requireAuth, verifyPayment);
router.route("/current").get(requireAuth, getCurrentSubscription);
router.route("/razorpay/webhook").post(WebhookRazorpay);
router.route("/cancel").delete(requireAuth, cancelSubscription);

// ================= super admin ========================

router.post(
  "/all-subscriptions",
  requireAuth,
  requireRole(["SUPER_ADMIN"]),
  allSubscriptions
);

export default router;
