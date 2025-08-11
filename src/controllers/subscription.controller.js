import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import Prisma from "../db/db.js";

const MAX_INT = Number.MAX_SAFE_INTEGER;

const planLimits = {
  FREE: {
    maxDomains: 1,
    maxMailboxes: 1,
    maxSentEmails: 50,
    maxReceivedEmails: 500,
    allowedStorageMB: 1024,
  },
  BASIC: {
    maxDomains: 3,
    maxMailboxes: 10,
    maxSentEmails: 1000,
    maxReceivedEmails: 10000,
    allowedStorageMB: 10240,
  },
  PREMIUM: {
    maxDomains: 10,
    maxMailboxes: 50,
    maxSentEmails: MAX_INT,      // use max int instead of Infinity
    maxReceivedEmails: MAX_INT,
    allowedStorageMB: 51200,
  },
};

const adjustLimitsForBillingCycle = (limits, billingCycle) => {
  if (billingCycle.toUpperCase() === "YEARLY") {
    return {
      maxDomains: Math.floor(limits.maxDomains * 1.5),
      maxMailboxes: Math.floor(limits.maxMailboxes * 1.5),
      maxSentEmails: limits.maxSentEmails === MAX_INT ? MAX_INT : Math.floor(limits.maxSentEmails * 1.5),
      maxReceivedEmails: limits.maxReceivedEmails === MAX_INT ? MAX_INT : Math.floor(limits.maxReceivedEmails * 1.5),
      allowedStorageMB: Math.floor(limits.allowedStorageMB * 1.5),
    };
  }
  return limits;
};

export const createOrRenewSubscription = asyncHandler(async (req, res) => {
  let { plan, billingCycle, razorpayOrderId, razorpayPaymentId, razorpayStatus, paymentStatus, paymentId, paymentProvider } = req.body;
  const userId = req.user.id;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpayStatus || !paymentStatus || !paymentProvider || !paymentId) {
    throw new ApiError(400, "All payment details are required");
  }

  if (!plan || !billingCycle) {
    throw new ApiError(400, "Plan and billing cycle are required");
  }

  plan = plan.toUpperCase();
  billingCycle = billingCycle.toUpperCase();

  const validPlans = Object.keys(planLimits);
  const validCycles = ["MONTHLY", "YEARLY"];

  if (!validPlans.includes(plan)) {
    throw new ApiError(400, "Invalid plan");
  }
  if (!validCycles.includes(billingCycle)) {
    throw new ApiError(400, "Invalid billing cycle");
  }

  let startDate = new Date();
  let endDate = new Date();

  if (plan === "FREE") {
    endDate.setDate(startDate.getDate() + 8); // 8 days free trial
  } else if (billingCycle === "MONTHLY") {
    endDate.setMonth(startDate.getMonth() + 1);
  } else if (billingCycle === "YEARLY") {
    endDate.setFullYear(startDate.getFullYear() + 1);
  }

  const baseLimits = planLimits[plan];
  const adjustedLimits = adjustLimitsForBillingCycle(baseLimits, billingCycle);

  // Try to get existing subscription for user
  const existingSub = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  // Keep storageUsedMB if exists, else 0
  const storageUsedMB = existingSub?.storageUsedMB || 0;

  const subscriptionData = {
    plan,
    billingCycle,
    maxDomains: adjustedLimits.maxDomains,
    maxMailboxes: adjustedLimits.maxMailboxes,
    maxSentEmails: adjustedLimits.maxSentEmails,
    maxReceivedEmails: adjustedLimits.maxReceivedEmails,
    allowedStorageMB: adjustedLimits.allowedStorageMB,
    storageUsedMB,
    paymentProviders: paymentProvider || 'RAZORPAY',
    paymentStatus: paymentStatus || "PENDING",
    paymentId: paymentId || null,
    razorpayOrderId: razorpayOrderId || null,
    razorpayPaymentId: razorpayPaymentId || null,
    razorpayStatus: razorpayStatus || null,
    startDate,
    endDate,
    isActive: true,
    userId,
  };

  if (existingSub) {
    // Renew subscription
    const updatedSub = await Prisma.subscription.update({
      where: { id: existingSub.id },
      data: subscriptionData,
    });
    return res.json(new ApiResponse(200, "Subscription renewed successfully", updatedSub));
  }

  // Create new subscription
  const newSub = await Prisma.subscription.create({
    data: subscriptionData,
  });

  res.status(201).json(new ApiResponse(201, "Subscription created successfully", newSub));
});

export const getMySubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new ApiError(401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    throw new ApiError(404, "No active subscription found");
  }

  return res.status(200).json(new ApiResponse(200, "Subscription retrieved", subscription));
});

export const cancelSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new ApiError(401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    throw new ApiError(404, "No active subscription found");
  }

  await Prisma.subscription.update({
    where: { id: subscription.id },
    data: { isActive: false, endDate: new Date() },
  });

  return res.status(200).json(new ApiResponse(200, "Subscription cancelled successfully"));
});
