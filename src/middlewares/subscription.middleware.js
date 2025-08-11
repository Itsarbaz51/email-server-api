import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";

export const verifySubscription = (action) => {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const user = await Prisma.user.findUnique({
      where: { id: userId },
      include: { subscriptions: true },
    });
    if (!user) throw new ApiError(404, "User not found");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const createdAt = new Date(user.createdAt);
    const diffDays = Math.floor((today - createdAt) / (1000 * 60 * 60 * 24));

    const subscription = user.subscription;

    // 1️⃣ FREE TRIAL (8 days)
    if (!subscription) {
      if (diffDays <= 8) {
        if (action === "createDomain") {
          const domainCount = await Prisma.domain.count({ where: { userId } });
          if (domainCount >= 1)
            throw new ApiError(403, "Free trial: Only 1 domain allowed");
        }
        if (action === "createMailbox") {
          const mailboxCount = await Prisma.mailbox.count({ where: { userId } });
          if (mailboxCount >= 1)
            throw new ApiError(403, "Free trial: Only 1 mailbox allowed");
        }
        if (action === "sendMail") {
          // Example limit for free trial, say 50 mails
          // Count sent emails in current billing period or total
          const sentCount = await Prisma.sentEmail.count({ where: { userId } });
          if (sentCount >= 50)
            throw new ApiError(403, "Free trial: Email send limit exceeded (50)");
        }
        if (action === "receiveMail") {
          // Example limit for free trial, say 500 mails
          const receivedCount = await Prisma.receivedEmail.count({ where: { userId } });
          if (receivedCount >= 500)
            throw new ApiError(403, "Free trial: Email receive limit exceeded (500)");
        }
        return next();
      }
      throw new ApiError(403, "Free trial expired. Please subscribe to continue");
    }

    // 2️⃣ SUBSCRIPTION EXPIRED CHECK
    const expiryDate = new Date(subscription.endDate);
    expiryDate.setHours(0, 0, 0, 0);
    if (today > expiryDate) {
      throw new ApiError(403, "Subscription expired. Please renew to continue");
    }

    // 3️⃣ PLAN LIMITS
    let maxDomains = subscription.maxDomains;
    let maxMailboxes = subscription.maxMailboxes;
    let maxSentEmails = subscription.maxSentEmails;
    let maxReceivedEmails = subscription.maxReceivedEmails;

    if (action === "createDomain") {
      const domainCount = await Prisma.domain.count({ where: { userId } });
      if (domainCount >= maxDomains) {
        throw new ApiError(403, `Plan limit exceeded: Max ${maxDomains} domains allowed.`);
      }
    }

    if (action === "createMailbox") {
      const mailboxCount = await Prisma.mailbox.count({ where: { userId } });
      if (mailboxCount >= maxMailboxes) {
        throw new ApiError(403, `Plan limit exceeded: Max ${maxMailboxes} mailboxes allowed.`);
      }
    }

    if (action === "sendMail") {
      const sentCount = await Prisma.sentEmail.count({ where: { userId } });
      if (sentCount >= maxSentEmails) {
        throw new ApiError(403, `Plan limit exceeded: Max ${maxSentEmails} sent emails allowed.`);
      }
    }

    if (action === "receiveMail") {
      const receivedCount = await Prisma.receivedEmail.count({ where: { userId } });
      if (receivedCount >= maxReceivedEmails) {
        throw new ApiError(403, `Plan limit exceeded: Max ${maxReceivedEmails} received emails allowed.`);
      }
    }

    return next();
  };
};
