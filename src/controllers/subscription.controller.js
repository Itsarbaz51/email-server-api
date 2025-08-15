import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import Prisma from "../db/db.js";
import Razorpay from "razorpay";
import axios from "axios";

const MAX_INT = Number.MAX_SAFE_INTEGER;

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// Example USD prices

const planPricesUSD = {
  BASIC: 5, // $5 per month
  PREMIUM: 15,
};

// Plan limits
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
    maxSentEmails: MAX_INT,
    maxReceivedEmails: MAX_INT,
    allowedStorageMB: 51200,
  },
};

// Adjust limits for yearly billing
const adjustLimitsForBillingCycle = (limits, billingCycle) => {
  if (billingCycle.toUpperCase() === "YEARLY") {
    return {
      maxDomains: Math.floor(limits.maxDomains * 1.5),
      maxMailboxes: Math.floor(limits.maxMailboxes * 1.5),
      maxSentEmails:
        limits.maxSentEmails === MAX_INT
          ? MAX_INT
          : Math.floor(limits.maxSentEmails * 1.5),
      maxReceivedEmails:
        limits.maxReceivedEmails === MAX_INT
          ? MAX_INT
          : Math.floor(limits.maxReceivedEmails * 1.5),
      allowedStorageMB: Math.floor(limits.allowedStorageMB * 1.5),
    };
  }
  return limits;
};

// Fetch USD→INR rate
async function getUsdToInrRate() {
  try {
    const res = await axios.get(
      "https://api.frankfurter.app/latest?from=USD&to=INR"
    );
    const data = await res.json();
    return data.rates?.INR || 83; // fallback
  } catch (error) {
    console.error("Error fetching exchange rate:", error);
    return 83; // fallback
  }
}

export const createOrRenewSubscription = asyncHandler(async (req, res) => {
  let {
    plan,
    billingCycle,
    razorpayOrderId,
    razorpayPaymentId,
    razorpayStatus,
    paymentStatus,
    paymentId,
    paymentProvider,
  } = req.body;

  const userId = req.user.id;

  if (!plan || !billingCycle)
    return ApiError.send(res, 400, "Plan and billing cycle are required");

  plan = plan.toUpperCase();
  billingCycle = billingCycle.toUpperCase();

  const validPlans = Object.keys(planLimits);
  const validCycles = ["MONTHLY", "YEARLY"];

  if (!validPlans.includes(plan))
    return ApiError.send(res, 400, "Invalid plan");
  if (!validCycles.includes(billingCycle))
    return ApiError.send(res, 400, "Invalid billing cycle");

  // Payment verification for paid plans
  if (plan !== "FREE") {
    if (!razorpayOrderId || !razorpayPaymentId) {
      return ApiError.send(
        res,
        400,
        "Payment details are required for paid plans"
      );
    }

    // Fetch live exchange rate
    const usdToInr = await getUsdToInrRate();
    let planPriceUSD = planPricesUSD[plan];
    if (billingCycle === "YEARLY") planPriceUSD *= 12; // yearly price

    const expectedAmountInPaise = Math.round(planPriceUSD * usdToInr * 100);

    // Verify Razorpay payment
    const payment = await razorpay.payments.fetch(razorpayPaymentId);
    if (!payment) return ApiError.send(res, 400, "Payment not found");

    if (payment.status !== "captured")
      return ApiError.send(res, 400, "Payment not captured");
    if (payment.order_id !== razorpayOrderId)
      return ApiError.send(res, 400, "Order ID mismatch");
    if (payment.amount !== expectedAmountInPaise) {
      return ApiError.send(
        res,
        400,
        `Payment amount mismatch. Expected ${expectedAmountInPaise}, got ${payment.amount}`
      );
    }

    paymentStatus = "SUCCESS";
    paymentProvider = "RAZORPAY";
    paymentId = payment.id;
    razorpayStatus = payment.status;
  }

  let startDate = new Date();
  let endDate = new Date();
  if (plan === "FREE") {
    endDate.setDate(startDate.getDate() + 8);
    paymentStatus = "FREE";
    paymentProvider = null;
    paymentId = null;
    razorpayOrderId = null;
    razorpayPaymentId = null;
    razorpayStatus = null;
  } else if (billingCycle === "MONTHLY") {
    endDate.setMonth(startDate.getMonth() + 1);
  } else if (billingCycle === "YEARLY") {
    endDate.setFullYear(startDate.getFullYear() + 1);
  }

  const baseLimits = planLimits[plan];
  const adjustedLimits = adjustLimitsForBillingCycle(baseLimits, billingCycle);

  const existingSub = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });
  const storageUsedMB = existingSub?.storageUsedMB || 0;

  const subscriptionData = {
    plan,
    billingCycle,
    ...adjustedLimits,
    storageUsedMB,
    paymentProvider,
    paymentStatus,
    paymentId,
    razorpayOrderId,
    razorpayPaymentId,
    razorpayStatus,
    startDate,
    endDate,
    isActive: true,
    userId,
  };

  if (existingSub) {
    const updatedSub = await Prisma.subscription.update({
      where: { id: existingSub.id },
      data: subscriptionData,
    });
    return res.json(
      new ApiResponse(200, "Subscription renewed successfully", updatedSub)
    );
  }

  const newSub = await Prisma.subscription.create({ data: subscriptionData });
  res
    .status(201)
    .json(new ApiResponse(201, "Subscription created successfully", newSub));
});

export const getMySubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return ApiError.send(res, 401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    return ApiError.send(res, 404, "No active subscription found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, "Subscription retrieved", subscription));
});

export const cancelSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return ApiError.send(res, 401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    return ApiError.send(res, 404, "No active subscription found");
  }

  await Prisma.subscription.update({
    where: { id: subscription.id },
    data: { isActive: false, endDate: new Date() },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Subscription cancelled successfully"));
});
