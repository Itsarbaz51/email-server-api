import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import Prisma from "../db/db.js";
import Razorpay from "razorpay";
import axios from "axios";
import { generateInvoiceId } from "../utils/lib.js";
import crypto from "crypto";

const MAX_INT = Number.MAX_SAFE_INTEGER;

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// ======================= PLAN CONFIG ======================
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

// ======================= PAYMENT VERIFY ======================
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

// ======================= CREATE/RENEW SUBSCRIPTION ======================
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

  // ---- Paid plan verification
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
    // Free plan
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
  else if (billingCycle === "MONTHLY")
    endDate.setMonth(startDate.getMonth() + 1);
  else if (billingCycle === "YEARLY")
    endDate.setFullYear(startDate.getFullYear() + 1);

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

  // create invoice
  await Prisma.invoice.create({
    data: {
      invoiceId: generateInvoiceId(),
      subscriptionId: subscription.id,
      amount:
        plan === "FREE"
          ? 0
          : billingCycle === "MONTHLY"
            ? planPricesUSD[plan] * 87
            : planPricesUSD[plan] * 87 * 12,
      status: paymentStatus === "SUCCESS" ? "PAID" : "PENDING",
    },
  });

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        existingSub ? "Subscription renewed" : "Subscription created",
        subscription
      )
    );
});

// ======================= CREATE RAZORPAY ORDER ======================
export const createRazorpayOrder = asyncHandler(async (req, res) => {
  const { plan, billingCycle, receiptId } = req.body;
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

  const amount = Math.round(priceUSD * usdToInr * 100);

  const receipt =
    receiptId || `ord_${plan.slice(0, 3)}_${Date.now()}`.slice(0, 40);

  const options = {
    amount,
    currency: "INR",
    receipt,
    notes: {
      userId: userId.toString(),
      plan: plan.toUpperCase(),
      billingCycle: billingCycle.toUpperCase(),
    },
  };

  try {
    const order = await razorpay.orders.create(options);
    return res
      .status(200)
      .json(new ApiResponse(200, "Order created successfully", order));
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    return ApiError.send(res, 500, "Failed to create order");
  }
});

// ======================= GET SUBSCRIPTION ======================

export const getCurrentSubscription = asyncHandler(async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return ApiError.send(res, 401, "Authentication required");

  const subscription = await Prisma.subscription.findFirst({
    where: { userId, isActive: true },
    include: { invoices: true },
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

// ======================= INVOICE HELPERS ======================
export async function updateInvoiceStatus(invoiceId, status) {
  return await Prisma.invoice.update({
    where: { id: invoiceId },
    data: { status },
  });
}

// ======================= RAZORPAY WEBHOOK ======================
export const WebhookRazorpay = asyncHandler(async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Verify signature
    const shasum = crypto.createHmac("sha256", secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest("hex");

    const signature = req.headers["x-razorpay-signature"];
    if (digest !== signature) {
      console.error("Invalid webhook signature");
      return res.status(400).json({ error: "Invalid signature" });
    }

    const event = req.body;
    console.log("Webhook event:", event.event);

    // =============================
    // ✅ Payment Captured
    // =============================
    if (event.event === "payment.captured") {
      const paymentId = event.payload.payment.entity.id;

      const subscription = await Prisma.subscription.findFirst({
        where: { paymentId },
      });

      if (subscription) {
        const invoice = await Prisma.invoice.findFirst({
          where: { subscriptionId: subscription.id },
        });

        if (invoice) {
          await updateInvoiceStatus(invoice.id, "PAID");
          console.log("✅ Invoice marked as PAID:", invoice.id);
        }
      }
    }

    // =============================
    // ❌ Payment Failed
    // =============================
    if (event.event === "payment.failed") {
      const paymentId = event.payload.payment.entity.id;

      const subscription = await Prisma.subscription.findFirst({
        where: { paymentId },
      });

      if (subscription) {
        const invoice = await Prisma.invoice.findFirst({
          where: { subscriptionId: subscription.id },
        });

        if (invoice) {
          await updateInvoiceStatus(invoice.id, "FAILED");
          console.log("❌ Invoice marked as FAILED:", invoice.id);
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook handling failed" });
  }
});

// ================================== suer admin ===============================

export const allSubscriptions = asyncHandler(async (req, res) => {
  // ---- Auth ----
  const superAdminId = req.user?.id;
  if (!superAdminId) return ApiError.send(res, 401, "Unauthorized user");
  if (req.user.role !== "SUPER_ADMIN") {
    return ApiError.send(
      res,
      403,
      "Forbidden: Only superadmin can access this"
    );
  }

  // ---- Query Params ----
  const page = Math.max(parseInt((req.query.page ?? "1").toString(), 10), 1);
  const limit = Math.min(
    Math.max(parseInt((req.query.limit ?? "20").toString(), 10), 1),
    100
  );
  const skip = (page - 1) * limit;

  const search = (req.query.search ?? "").toString().trim();
  const statusParam = (req.query.status ?? "").toString().trim() || undefined;

  const autoRenewParam = (req.query.autoRenew ?? "").toString().toLowerCase();
  const autoRenewFilter =
    autoRenewParam === "true"
      ? true
      : autoRenewParam === "false"
        ? false
        : undefined;

  const userId = (req.query.userId ?? "").toString().trim() || undefined;
  const productId = (req.query.productId ?? "").toString().trim() || undefined;
  const planId = (req.query.planId ?? "").toString().trim() || undefined;

  const includeTrashed =
    (req.query.includeTrashed ?? "false").toString().toLowerCase() === "true";

  const sortWhitelist = [
    "createdAt",
    "updatedAt",
    "currentPeriodStart",
    "currentPeriodEnd",
    "renewedAt",
    "status",
    "amount",
    "planName",
  ];
  const sortBy = sortWhitelist.includes((req.query.sortBy ?? "").toString())
    ? req.query.sortBy.toString()
    : "createdAt";
  const sortOrder =
    (req.query.sortOrder ?? "desc").toString().toLowerCase() === "asc"
      ? "asc"
      : "desc";

  // ---- Date ranges ----
  const toDate = (v) => (v ? new Date(v.toString()) : undefined);

  const dateFrom = toDate(req.query.dateFrom);
  const dateTo = toDate(req.query.dateTo);

  const activeFrom = toDate(req.query.activeFrom);
  const activeTo = toDate(req.query.activeTo);

  const expireFrom = toDate(req.query.expireFrom);
  const expireTo = toDate(req.query.expireTo);

  const renewedFrom = toDate(req.query.renewedFrom);
  const renewedTo = toDate(req.query.renewedTo);

  // ---- Where ----
  /**
   * Adjust field names per your Prisma schema:
   * - model: Subscription
   * - fields: subscriptionCode | planName | amount | status | autoRenew | currentPeriodStart | currentPeriodEnd | renewedAt | deletedAt | createdAt
   * - relations: user, product, plan
   */
  const where = {
    ...(!includeTrashed ? { deletedAt: null } : {}),
    ...(statusParam ? { status: statusParam } : {}),
    ...(typeof autoRenewFilter === "boolean"
      ? { autoRenew: autoRenewFilter }
      : {}),
    ...(userId ? { userId } : {}),
    ...(productId ? { productId } : {}),
    ...(planId ? { planId } : {}),
    ...(search
      ? {
          OR: [
            { subscriptionCode: { contains: search, mode: "insensitive" } },
            { planName: { contains: search, mode: "insensitive" } },
            {
              user: {
                OR: [
                  { name: { contains: search, mode: "insensitive" } },
                  { email: { contains: search, mode: "insensitive" } },
                ],
              },
            },
            { product: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
    ...(activeFrom || activeTo
      ? {
          currentPeriodStart: {
            ...(activeFrom ? { gte: activeFrom } : {}),
            ...(activeTo ? { lte: activeTo } : {}),
          },
        }
      : {}),
    ...(expireFrom || expireTo
      ? {
          currentPeriodEnd: {
            ...(expireFrom ? { gte: expireFrom } : {}),
            ...(expireTo ? { lte: expireTo } : {}),
          },
        }
      : {}),
    ...(renewedFrom || renewedTo
      ? {
          renewedAt: {
            ...(renewedFrom ? { gte: renewedFrom } : {}),
            ...(renewedTo ? { lte: renewedTo } : {}),
          },
        }
      : {}),
  };

  // ---- DB ----
  const [total, subscriptions] = await Promise.all([
    Prisma.subscription.count({ where }),
    Prisma.subscription.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
      select: {
        id: true,
        subscriptionCode: true,
        status: true,
        planName: true,
        amount: true,
        currency: true,
        autoRenew: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        renewedAt: true,
        createdAt: true,
        updatedAt: true,
        userId: true,
        productId: true,
        planId: true,
        user: { select: { id: true, name: true, email: true } },
        product: { select: { id: true, name: true } },
        plan: {
          select: { id: true, name: true, interval: true, intervalCount: true },
        },
      },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return res.status(200).json(
    new ApiResponse(200, "All subscriptions fetched successfully", {
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        sortBy,
        sortOrder,
      },
      filters: {
        search: search || null,
        status: statusParam || null,
        autoRenew:
          typeof autoRenewFilter === "boolean" ? autoRenewFilter : null,
        userId: userId || null,
        productId: productId || null,
        planId: planId || null,
        dateFrom: dateFrom ? dateFrom.toISOString() : null,
        dateTo: dateTo ? dateTo.toISOString() : null,
        activeFrom: activeFrom ? activeFrom.toISOString() : null,
        activeTo: activeTo ? activeTo.toISOString() : null,
        expireFrom: expireFrom ? expireFrom.toISOString() : null,
        expireTo: expireTo ? expireTo.toISOString() : null,
        renewedFrom: renewedFrom ? renewedFrom.toISOString() : null,
        renewedTo: renewedTo ? renewedTo.toISOString() : null,
        includeTrashed,
      },
      data: subscriptions,
    })
  );
});
