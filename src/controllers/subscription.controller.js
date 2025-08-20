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

const planPricesUSD = {
  BASIC: 5,
  PREMIUM: 15,
};

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

async function getUsdToInrRate() {
  try {
    const res = await axios.get(
      "https://api.frankfurter.app/latest?from=USD&to=INR"
    );
    return res.data.rates?.INR || 83;
  } catch (error) {
    console.error("Error fetching exchange rate:", error);
    return 83;
  }
}

export const verifyPayment = asyncHandler(async (req, res) => {
  const { razorpayPaymentId, razorpayOrderId, expectedAmount } = req.body;

  if (!razorpayPaymentId || !razorpayOrderId || !expectedAmount)
    return ApiError.send(res, 400, "Missing payment verification fields");

  const payment = await razorpay.payments.fetch(razorpayPaymentId);

  if (
    !payment ||
    payment.status !== "captured" ||
    payment.order_id !== razorpayOrderId ||
    payment.amount !== expectedAmount
  ) {
    return ApiError.send(res, 400, "Payment verification failed");
  }

  return res.status(200).json(
    new ApiResponse(200, "Payment verified", {
      paymentId: payment.id,
      status: payment.status,
    })
  );
});

export const createOrRenewSubscription = asyncHandler(async (req, res) => {
  let {
    plan,
    billingCycle,
    razorpayOrderId,
    razorpayPaymentId,
    paymentStatus,
    paymentId,
    paymentProvider,
    razorpayStatus,
  } = req.body;

  const userId = req.user.id;

  if (!plan || !billingCycle)
    return ApiError.send(res, 400, "Plan and billing cycle required");

  plan = plan.toUpperCase();
  billingCycle = billingCycle.toUpperCase();

  const validPlans = Object.keys(planLimits);
  const validCycles = ["MONTHLY", "YEARLY"];
  if (!validPlans.includes(plan))
    return ApiError.send(res, 400, "Invalid plan");
  if (!validCycles.includes(billingCycle))
    return ApiError.send(res, 400, "Invalid billing cycle");

  // For paid plans: validate Razorpay payment again
  if (plan !== "FREE") {
    if (!razorpayOrderId || !razorpayPaymentId)
      return ApiError.send(res, 400, "Payment details missing");

    const usdToInr = await getUsdToInrRate();
    let priceUSD = planPricesUSD[plan];
    if (billingCycle === "YEARLY") priceUSD *= 12;
    const expectedAmount = Math.round(priceUSD * usdToInr * 100);

    const payment = await razorpay.payments.fetch(razorpayPaymentId);
    if (
      !payment ||
      payment.status !== "captured" ||
      payment.order_id !== razorpayOrderId ||
      payment.amount !== expectedAmount
    ) {
      return ApiError.send(res, 400, "Payment verification failed");
    }

    paymentStatus = "SUCCESS";
    paymentProvider = "RAZORPAY";
    paymentId = payment.id;
    razorpayStatus = payment.status;
  } else {
    // Free plan trial setup
    paymentStatus = "FREE";
    paymentProvider = "FREE";
    paymentId = null;
    razorpayOrderId = null;
    razorpayPaymentId = null;
    razorpayStatus = null;
  }

  const startDate = new Date();
  const endDate = new Date();
  if (plan === "FREE") endDate.setDate(startDate.getDate() + 8);
  else if (billingCycle === "MONTHLY") endDate.setMonth(startDate.getMonth() + 1);
  else if (billingCycle === "YEARLY") endDate.setFullYear(startDate.getFullYear() + 1);

  const limits = adjustLimitsForBillingCycle(planLimits[plan], billingCycle);

  const existingSub = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  const storageUsedMB = existingSub?.storageUsedMB || 0;

  const data = {
    userId,
    plan,
    billingCycle,
    ...limits,
    storageUsedMB,
    startDate,
    endDate,
    isActive: true,
    paymentStatus,
    paymentProvider,
    paymentId,
    razorpayOrderId,
    razorpayPaymentId,
    razorpayStatus,
  };

  const subscription = existingSub
    ? await Prisma.subscription.update({ where: { id: existingSub.id }, data })
    : await Prisma.subscription.create({ data });

  return res.status(200).json(
    new ApiResponse(200, existingSub ? "Subscription renewed" : "Subscription created", subscription)
  );
});

export const createRazorpayOrder = asyncHandler(async (req, res) => {
  const { plan, billingCycle } = req.body;
  const userId = req.user.id;

  if (!plan || !billingCycle) {
    return ApiError.send(res, 400, "Plan and billing cycle required");
  }

  const validPlans = ["BASIC", "PREMIUM"];
  const validCycles = ["MONTHLY", "YEARLY"];

  if (!validPlans.includes(plan.toUpperCase())) {
    return ApiError.send(res, 400, "Invalid plan");
  }
  if (!validCycles.includes(billingCycle.toUpperCase())) {
    return ApiError.send(res, 400, "Invalid billing cycle");
  }

  const usdToInr = await getUsdToInrRate();
  let priceUSD = planPricesUSD[plan.toUpperCase()];

  if (billingCycle.toUpperCase() === "YEARLY") {
    priceUSD *= 12;
  }

  const amount = Math.round(priceUSD * usdToInr * 100); // Razorpay expects amount in paise

  const options = {
    amount,
    currency: "INR",
    receipt: `order_rcptid_${userId}_${Date.now()}`,
    notes: {
      userId: userId.toString(),
      plan: plan.toUpperCase(),
      billingCycle: billingCycle.toUpperCase()
    }
  };

  try {
    const order = await razorpay.orders.create(options);
    return res.status(200).json(
      new ApiResponse(200, "Order created successfully", order)
    );
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    return ApiError.send(res, 500, "Failed to create order");
  }
});

export const getCurrentSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return ApiError.send(res, 401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription) {
    return ApiError.send(res, 404, "No active subscription found");
  }

  return res.status(200).json(
    new ApiResponse(200, "Subscription retrieved", subscription)
  );
});

export const getMySubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return ApiError.send(res, 401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
  });

  if (!subscription)
    return ApiError.send(res, 404, "No active subscription found");

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

  if (!subscription)
    return ApiError.send(res, 404, "No active subscription found");

  await Prisma.subscription.update({
    where: { id: subscription.id },
    data: { isActive: false, endDate: new Date() },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Subscription cancelled successfully"));
});