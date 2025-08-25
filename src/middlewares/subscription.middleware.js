import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

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
    maxSentEmails: Number.MAX_SAFE_INTEGER,
    maxReceivedEmails: Number.MAX_SAFE_INTEGER,
    allowedStorageMB: 51200,
  },
};

export const verifySubscription = (action) =>
  asyncHandler(async (req, res, next) => {
    let userId = req.user?.id;
    let mailboxId = req.mailbox?.id;

    // Agar req.mailbox se aaya hai to us mailbox ka userId nikaal lo
    if (!userId && mailboxId) {
      const mailbox = await Prisma.mailbox.findUnique({
        where: { id: mailboxId },
        select: { userId: true },
      });
      if (!mailbox) {
        return ApiError.send(res, 404, "Mailbox not found");
      }
      userId = mailbox.userId;
    }

    if (!userId) {
      return ApiError.send(res, 401, "Unauthorized: User not found");
    }

    // Step 1: Get active subscription
    const subscription = await Prisma.subscription.findFirst({
      where: {
        userId,
        isActive: true,
        paymentStatus: "SUCCESS",
      },
    });

    if (!subscription) {
      return ApiError.send(
        res,
        403,
        "No active subscription found. Please subscribe to continue."
      );
    }

    // Step 2: Check expiry
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiryDate = new Date(subscription.endDate);
    expiryDate.setHours(0, 0, 0, 0);

    if (today > expiryDate) {
      return ApiError.send(res, 403, "Subscription expired. Please renew.");
    }

    // Step 3: Get plan limits
    const plan = subscription.plan?.toUpperCase(); // FREE, BASIC, PREMIUM
    const limits = planLimits[plan] || planLimits.FREE;

    // Step 4: Plan-specific checks
    if (action === "createDomain") {
      const domainCount = await Prisma.domain.count({ where: { userId } });
      if (domainCount >= limits.maxDomains) {
        return ApiError.send(
          res,
          403,
          `Plan limit exceeded: Max ${limits.maxDomains} domains allowed for ${plan} plan.`
        );
      }
    }

    if (action === "createMailbox") {
      const mailboxCount = await Prisma.mailbox.count({ where: { userId } });
      if (mailboxCount >= limits.maxMailboxes) {
        return ApiError.send(
          res,
          403,
          `Plan limit exceeded: Max ${limits.maxMailboxes} mailboxes allowed for ${plan} plan.`
        );
      }
    }

    if (action === "sendMail") {
      const count = await Prisma.sentEmail.count({
        where: { mailboxId },
      });
      if (count >= limits.maxSentEmails) {
        return ApiError.send(
          res,
          403,
          `Plan limit exceeded: Max ${limits.maxSentEmails} sent emails allowed for ${plan} plan.`
        );
      }
    }

    if (action === "receiveMail") {
      const count = await Prisma.receivedEmail.count({
        where: { mailboxId },
      });
      if (count >= limits.maxReceivedEmails) {
        return ApiError.send(
          res,
          403,
          `Plan limit exceeded: Max ${limits.maxReceivedEmails} received emails allowed for ${plan} plan.`
        );
      }
    }
    return next();
  });

