import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";

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
    today.setHours(0, 0, 0, 0); // Remove time for date-only comparison
    const createdAt = new Date(user.createdAt);
    const diffDays = Math.floor((today - createdAt) / (1000 * 60 * 60 * 24));

    const subscription = user.subscription;

    // ===============================
    // 1️⃣ FREE TRIAL (8 Days)
    // ===============================
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
        return next();
      }
      throw new ApiError(403, "Free trial expired. Please subscribe to continue");
    }

    // ===============================
    // 2️⃣ SUBSCRIPTION EXPIRED CHECK
    // ===============================
    const expiryDate = new Date(subscription.endDate);
    expiryDate.setHours(0, 0, 0, 0);
    if (today > expiryDate) {
      throw new ApiError(403, "Subscription expired. Please renew to continue");
    }

    // ===============================
    // 3️⃣ PLAN LIMITS
    // ===============================
    const plan = subscription.plan?.toUpperCase();

    const planLimits = {
      BASIC: { domains: 2, mailboxes: 5 },
      PREMIUM: { domains: Infinity, mailboxes: Infinity },
    };

    if (plan === "BASIC") {
      if (action === "createDomain") {
        const domainCount = await Prisma.domain.count({ where: { userId } });
        if (domainCount >= planLimits.BASIC.domains) {
          throw new ApiError(403, "Basic plan: Max 2 domains allowed");
        }
      }
      if (action === "createMailbox") {
        const mailboxCount = await Prisma.mailbox.count({ where: { userId } });
        if (mailboxCount >= planLimits.BASIC.mailboxes) {
          throw new ApiError(403, "Basic plan: Max 5 mailboxes allowed");
        }
      }
    }

    // PREMIUM has no limits
    return next();
  };
};
