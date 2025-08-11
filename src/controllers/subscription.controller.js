import { PrismaClient } from "@prisma/client";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const prisma = new PrismaClient();

// Create subscription (Free Trial or Paid)
export const createOrRenewSubscription = async (req, res) => {
  try {
    const { plan, billingCycle, razorpayOrderId, razorpayPaymentId, razorpayStatus } = req.body;
    const userId = req.user.id;

    // Validate plan
    const validPlans = ["FREE", "BASIC", "PREMIUM"];
    if (!validPlans.includes(plan.toUpperCase())) {
      return res.status(400).json({ message: "Invalid plan" });
    }

    // Validate billing cycle
    const validCycles = ["MONTHLY", "YEARLY"];
    if (!validCycles.includes(billingCycle.toUpperCase())) {
      return res.status(400).json({ message: "Invalid billing cycle" });
    }

    let startDate = new Date();
    let endDate = new Date();

    if (plan.toUpperCase() === "FREE") {
      endDate.setDate(startDate.getDate() + 8); // 8 days trial
    } else if (billingCycle.toUpperCase() === "MONTHLY") {
      endDate.setMonth(startDate.getMonth() + 1);
    } else if (billingCycle.toUpperCase() === "YEARLY") {
      endDate.setFullYear(startDate.getFullYear() + 1);
    }

    // Check if user already has subscription
    const existingSub = await prisma.subscription.findFirst({
      where: { userId, isActive: true }
    });

    if (existingSub) {
      // Renew existing subscription
      const updatedSub = await prisma.subscription.update({
        where: { id: existingSub.id },
        data: {
          plan,
          billingCycle,
          razorpayOrderId,
          razorpayPaymentId,
          razorpayStatus,
          startDate,
          endDate,
          isActive: true
        }
      });
      return res.json({ message: "Subscription renewed successfully", subscription: updatedSub });
    }

    // Create new subscription
    const newSub = await prisma.subscription.create({
      data: {
        plan,
        billingCycle,
        razorpayOrderId,
        razorpayPaymentId,
        razorpayStatus,
        startDate,
        endDate,
        isActive: true,
        userId
      }
    });

    res.status(201).json({ message: "Subscription created successfully", subscription: newSub });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


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
