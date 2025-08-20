import Prisma from "../db/db";
import { ApiResponse } from "../utils/ApiResponse";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";

export const getDashboardData = asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;

    const totalDomains = await Prisma.domain.count({ where: { userId } });
    const totalMailboxes = await Prisma.mailbox.count({ where: { userId } });
    const totalReceivedEmails = await Prisma.receivedEmail.count({
      where: { userId },
    });
    const totalSentEmails = await Prisma.sentEmail.count({ where: { userId } });

    const storageUsed = await Prisma.attachment.aggregate({
      where: { userId },
      _sum: { fileSize: true },
    });

    const recentDomains = await Prisma.domain.findMany({
      where: { userId },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { mailboxes: true },
    });

    const recentSentEmails = await Prisma.sentEmail.findMany({
      where: { userId },
      take: 5,
      orderBy: { sentAt: "desc" },
      include: { mailbox: true },
    });

    const recentReceivedEmails = await Prisma.receivedEmail.findMany({
      where: { userId },
      take: 5,
      orderBy: { receivedAt: "desc" },
      include: { mailbox: true },
    });

    return res.status(200).json(
      new ApiResponse(200, "Dashboard data fetched successfully", {
        totalDomains,
        totalMailboxes,
        totalReceivedEmails,
        totalSentEmails,
        storageUsed: storageUsed._sum.fileSize
          ? (storageUsed._sum.fileSize / 1024 / 1024 / 1024).toFixed(2)
          : 0,
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
