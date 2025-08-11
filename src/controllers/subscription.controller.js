import { PrismaClient } from "@prisma/client";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const prisma = new PrismaClient();

// Create subscription (Free Trial or Paid)
export const createSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { plan, razorpayOrderId, razorpayPaymentId, razorpayStatus } = req.body;

  if (!userId) throw new ApiError(401, "Authentication required");

  // ✅ Check if user already has active subscription
  const existing = await prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (existing) {
    throw new ApiError(400, "User already has an active subscription");
  }

  // Set limits based on plan
  const limits = {
    FREE: { maxDomains: 1, maxMailboxes: 1, maxStorageMB: 1024 },
    BASIC: { maxDomains: 3, maxMailboxes: 10, maxStorageMB: 10240 },
    PREMIUM: { maxDomains: 10, maxMailboxes: 50, maxStorageMB: 51200 },
  };

  const subscription = await prisma.subscription.create({
    data: {
      userId,
      plan: plan || "FREE",
      maxDomains: limits[plan || "FREE"].maxDomains,
      maxMailboxes: limits[plan || "FREE"].maxMailboxes,
      maxStorageMB: limits[plan || "FREE"].maxStorageMB,
      razorpayOrderId,
      razorpayPaymentId,
      razorpayStatus: razorpayStatus || "PENDING",
      trialUsed: plan === "FREE",
    },
  });

  return res
    .status(201)
    .json(new ApiResponse(201, "Subscription created", subscription));
});

// Get current user's subscription
export const getMySubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new ApiError(401, "Authentication required");

  const subscription = await prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    throw new ApiError(404, "No active subscription found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Subscription retrieved", subscription));
});

// Update subscription plan (Upgrade/Downgrade)
export const updateSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  const { plan, razorpayOrderId, razorpayPaymentId, razorpayStatus } = req.body;

  if (!userId) throw new ApiError(401, "Authentication required");

  const subscription = await prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    throw new ApiError(404, "No active subscription found");
  }

  // Set limits based on new plan
  const limits = {
    FREE: { maxDomains: 1, maxMailboxes: 1, maxStorageMB: 1024 },
    BASIC: { maxDomains: 3, maxMailboxes: 10, maxStorageMB: 10240 },
    PREMIUM: { maxDomains: 10, maxMailboxes: 50, maxStorageMB: 51200 },
  };

  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      plan,
      maxDomains: limits[plan].maxDomains,
      maxMailboxes: limits[plan].maxMailboxes,
      maxStorageMB: limits[plan].maxStorageMB,
      razorpayOrderId,
      razorpayPaymentId,
      razorpayStatus,
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Subscription updated", updated));
});

// Cancel subscription
export const cancelSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) throw new ApiError(401, "Authentication required");

  const subscription = await prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    throw new ApiError(404, "No active subscription found");
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { isActive: false, endDate: new Date() },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Subscription cancelled successfully"));
});
