import Prisma from "../db/db.js";
import {ApiError} from "../utils/ApiError.js";

export const verifySubscription = (action) => {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) throw new ApiError(401, "Unauthorized");

    const user = await Prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    if (!user) throw new ApiError(404, "User not found");

    const today = new Date();
    const createdAt = new Date(user.createdAt);
    const diffDays = Math.floor((today - createdAt) / (1000 * 60 * 60 * 24));

    const subscription = user.subscription;

    // ===============================
    // 1️⃣ FREE TRIAL (8 Days)
    // ===============================
    if (!subscription) {
      if (diffDays <= 8) {
        // Free trial still active
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
        return next();
      } else {
        throw new ApiError(403, "Free trial expired. Please subscribe to continue");
      }
    }

    // ===============================
    // 2️⃣ SUBSCRIPTION EXPIRED CHECK
    // ===============================
    const expiryDate = new Date(subscription.endDate);
    if (today > expiryDate) {
      throw new ApiError(403, "Subscription expired. Please renew to continue");
    }

    // ===============================
    // 3️⃣ PLAN LIMITS
    // ===============================

    // BASIC Plan
    if (subscription.plan === "BASIC") {
      if (action === "createDomain") {
        const domainCount = await Prisma.domain.count({ where: { userId } });
        if (domainCount >= 2)
          throw new ApiError(403, "Basic plan: Max 2 domains allowed");
      }
      if (action === "createMailbox") {
        const mailboxCount = await Prisma.mailbox.count({ where: { userId } });
        if (mailboxCount >= 5)
          throw new ApiError(403, "Basic plan: Max 5 mailboxes allowed");
      }
      if (["sendMail", "receiveMail"].includes(action)) {
        return next(); // Allowed while subscription active
      }
    }

    // PREMIUM Plan
    if (subscription.plan === "PREMIUM") {
      // No limits — allowed everything
      return next();
    }

    // If no matching plan found, allow by default
    return next();
  };
};
