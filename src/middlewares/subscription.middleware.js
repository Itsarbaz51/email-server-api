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

export const verifySubscription = (action) => asyncHandler(async (req, res, next) => {
  const userId = req.user?.id;
  const mailboxId = req.mailbox?.id;

  if (!userId && !mailboxId) {
    return ApiError.send(res, 401, "Unauthorized: No user or mailbox found");
  }

  let subscription;
  let createdAt;

  if (userId) {
    const user = await Prisma.user.findUnique({
      where: { id: userId },
      include: { subscriptions: true },
    });
    if (!user) return ApiError.send(res, 404, "User not found");

    createdAt = user.createdAt;
    subscription = await Prisma.subscription.findFirst({
      where: {
        userId,
        isActive: true,
        paymentStatus: "SUCCESS",
      },
    });
  } else {
    const mailbox = await Prisma.mailbox.findUnique({
      where: { id: mailboxId },
      include: { user: { select: { createdAt: true, id: true } } },
    });
    if (!mailbox) return ApiError.send(res, 404, "Mailbox not found");

    createdAt = mailbox.user?.createdAt ?? new Date();
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today - createdAt) / (1000 * 60 * 60 * 24));

  let limits;

  if (!subscription) {
    if (diffDays > 8) {
      return ApiError.send(res, 403, "Free trial expired. Please subscribe to continue");
    }
    limits = planLimits.FREE;
  } else {
    const expiryDate = new Date(subscription.endDate);
    expiryDate.setHours(0, 0, 0, 0);
    if (today > expiryDate) {
      return ApiError.send(res, 403, "Subscription expired. Please renew to continue");
    }

    limits = {
      maxDomains: subscription.maxDomains,
      maxMailboxes: subscription.maxMailboxes,
      maxSentEmails: subscription.maxSentEmails,
      maxReceivedEmails: subscription.maxReceivedEmails,
    };
  }

  // Action-specific checks
  const entityId = userId || mailboxId;

  switch (action) {
    case "createDomain":
      const domainCount = await Prisma.domain.count({
        where: { userId: userId },
      });
      if (domainCount >= limits.maxDomains) {
        return ApiError.send(res, 403, `Plan limit exceeded: Max ${limits.maxDomains} domains allowed`);
      }
      break;

    case "createMailbox":
      const mailboxCount = await Prisma.mailbox.count({
        where: { userId: userId },
      });
      if (mailboxCount >= limits.maxMailboxes) {
        return ApiError.send(res, 403, `Plan limit exceeded: Max ${limits.maxMailboxes} mailboxes allowed`);
      }
      break;

    case "sendMail":
      const sentCount = await Prisma.sentEmail.count({
        where: mailboxId ? { mailboxId } : { userId },
      });
      if (sentCount >= limits.maxSentEmails) {
        return ApiError.send(res, 403, `Plan limit exceeded: Max ${limits.maxSentEmails} sent emails allowed`);
      }
      break;

    case "receiveMail":
      const receivedCount = await Prisma.receivedEmail.count({
        where: mailboxId ? { mailboxId } : { userId },
      });
      if (receivedCount >= limits.maxReceivedEmails) {
        return ApiError.send(res, 403, `Plan limit exceeded: Max ${limits.maxReceivedEmails} received emails allowed`);
      }
      break;

    case "verifyDomain":
      // Assuming domain verification is allowed if domain already exists.
      break;

    default:
      break;
  }

  next();
});
