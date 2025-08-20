import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const getDashboardData = asyncHandler(async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return ApiError.send(res, 401, "Unauthraized Admin");
    }

    const totalDomains = await Prisma.domain.count({ where: { userId } });
    if (!totalDomains)
      return ApiError.send(res, 404, "total Doamins not found");
    const totalMailboxes = await Prisma.mailbox.count({ where: { userId } });
    if (!totalMailboxes)
      return ApiError.send(res, 404, "total Mailbox not found");
    const totalReceivedEmails = await Prisma.receivedEmail.count({
      where: { userId },
    });
    if (!totalReceivedEmails)
      return ApiError.send(res, 404, "total received emails not found");

    const totalSentEmails = await Prisma.sentEmail.count({ where: { userId } });
    if (!totalSentEmails)
      return ApiError.send(res, 404, "total sent emails not found");

    const storageUsed = await Prisma.attachment.aggregate({
      where: { userId },
      _sum: { fileSize: true },
    });
    if (!storageUsed) return ApiError.send(res, 404, "storage (0)");

    const recentDomains = await Prisma.domain.findMany({
      where: { userId },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { mailboxes: true },
    });

    if (!storageUsed) return ApiError.send(res, 404, "recent doamin (0)");

    const recentSentEmails = await Prisma.sentEmail.findMany({
      where: { userId },
      take: 5,
      orderBy: { sentAt: "desc" },
      include: { mailbox: true },
    });
    if (!recentSentEmails)
      return ApiError.send(res, 404, "recent sent mail (0)");

    const recentReceivedEmails = await Prisma.receivedEmail.findMany({
      where: { userId },
      take: 5,
      orderBy: { receivedAt: "desc" },
      include: { mailbox: true },
    });
    if (!recentReceivedEmails)
      return ApiError.send(res, 404, "recent received mail (0)");

    return res.status(200).json(
      new ApiResponse(200, "Dashboard data fetched successfully", {
        totalDomains,
        totalMailboxes,
        totalReceivedEmails,
        totalSentEmails,
        storageUsed: storageUsed._sum.fileSize,
        recentDomains: recentDomains.map((d) => ({
          id: d.id,
          name: d.name,
          mailboxes: d.mailboxes.length,
          status: d.status,
        })),
        recentSentEmails: recentSentEmails.map((e) => ({
          id: e.id,
          subject: e.subject,
          to: e.toEmail,
          sentAt: e.sentAt,
          mailbox: e.mailbox?.emailAddress,
        })),
        recentReceivedEmails: recentReceivedEmails.map((e) => ({
          id: e.id,
          subject: e.subject,
          from: e.fromEmail,
          receivedAt: e.receivedAt,
          mailbox: e.mailbox?.emailAddress,
        })),
      })
    );
  } catch (error) {
    console.error("Dashboard fetch error:", error);
    return ApiError.send(res, 500, "Failed to fetch dashboard data");
  }
});
