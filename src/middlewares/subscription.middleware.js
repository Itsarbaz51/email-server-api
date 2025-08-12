import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";

export const verifySubscription = (action) => {
  return async (req, res, next) => {
    // Determine whether the request is from user or mailbox
    const userId = req.user?.id;
    const mailboxId = req.mailbox?.id;

    if (!userId && !mailboxId) {
      return next(new ApiError.send(res, 401, "Unauthorized: No user or mailbox found"));
    }

    // Fetch user or mailbox info accordingly
    let subscription;
    let createdAt;

    if (userId) {
      // Normal user flow
      const user = await Prisma.user.findUnique({
        where: { id: userId },
        include: { subscriptions: true },
      });

      if (!user) return next(new ApiError.send(res, 404, "User not found"));

      subscription = user.subscriptions?.find((sub) => sub.isActive) || null;
      createdAt = new Date(user.createdAt);
    } else {
      // Mailbox flow
      const mailbox = await Prisma.mailbox.findUnique({
        where: { id: mailboxId },
        include: { user: { select: { createdAt: true } } },
      });

      if (!mailbox) return next(new ApiError.send(res, 404, "Mailbox not found"));

      // Mailboxes usually don't have subscriptions, so get from related user if needed
      subscription = null; // or customize if mailbox has subscription
      createdAt = mailbox.user ? new Date(mailbox.user.createdAt) : new Date();
    }

    // Free trial logic: 8 days since creation
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((today - createdAt) / (1000 * 60 * 60 * 24));

    if (!subscription) {
      if (diffDays <= 8) {
        // Free trial limits
        if (action === "createDomain") {
          const count = await Prisma.domain.count({ where: { userId: userId || mailboxId } });
          if (count >= 1) return next(new ApiError.send(res, 403, "Free trial: Only 1 domain allowed"));
        }
        if (action === "createMailbox") {
          const count = await Prisma.mailbox.count({ where: { userId: userId || mailboxId } });
          if (count >= 1) return next(new ApiError.send(res, 403, "Free trial: Only 1 mailbox allowed"));
        }
        if (action === "sendMail") {
          const count = mailboxId
            ? await Prisma.sentEmail.count({ where: { mailboxId } })
            : await Prisma.sentEmail.count({ where: { userId } });
          if (count >= 50) return next(new ApiError.send(res, 403, "Free trial: Email send limit exceeded (50)"));
        }
        if (action === "receiveMail") {
          const count = mailboxId
            ? await Prisma.receivedEmail.count({ where: { mailboxId } })
            : await Prisma.receivedEmail.count({ where: { userId } });
          if (count >= 500) return next(new ApiError.send(res, 403, "Free trial: Email receive limit exceeded (500)"));
        }
        return next();
      }
      return next(new ApiError.send(res, 403, "Free trial expired. Please subscribe to continue"));
    }

    // Subscription expiration check
    const expiryDate = new Date(subscription.endDate);
    expiryDate.setHours(0, 0, 0, 0);
    if (today > expiryDate) {
      return next(new ApiError.send(res, 403, "Subscription expired. Please renew to continue"));
    }

    // Plan limits
    const maxDomains = subscription.maxDomains;
    const maxMailboxes = subscription.maxMailboxes;
    const maxSentEmails = subscription.maxSentEmails;
    const maxReceivedEmails = subscription.maxReceivedEmails;

    if (action === "createDomain") {
      const count = await Prisma.domain.count({ where: { userId: userId || mailboxId } });
      if (count >= maxDomains)
        return next(new ApiError.send(res, 403, `Plan limit exceeded: Max ${maxDomains} domains allowed.`));
    }

    if (action === "createMailbox") {
      const count = await Prisma.mailbox.count({ where: { userId: userId || mailboxId } });
      if (count >= maxMailboxes)
        return next(new ApiError.send(res, 403, `Plan limit exceeded: Max ${maxMailboxes} mailboxes allowed.`));
    }

    if (action === "sendMail") {
      const count = mailboxId
        ? await Prisma.sentEmail.count({ where: { mailboxId } })
        : await Prisma.sentEmail.count({ where: { userId } });
      if (count >= maxSentEmails)
        return next(new ApiError.send(res, 403, `Plan limit exceeded: Max ${maxSentEmails} sent emails allowed.`));
    }

    if (action === "receiveMail") {
      const count = mailboxId
        ? await Prisma.receivedEmail.count({ where: { mailboxId } })
        : await Prisma.receivedEmail.count({ where: { userId } });
      if (count >= maxReceivedEmails)
        return next(new ApiError.send(res, 403, `Plan limit exceeded: Max ${maxReceivedEmails} received emails allowed.`));
    }

    return next();
  };
};
