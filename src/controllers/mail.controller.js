// src/controllers/mail.controller.js
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Prisma from "../db/db.js";
import { sendViaSendGrid } from "../services/sendgridService.js";
import { uploadToS3 } from "../services/s3Service.js";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() });

// sendEmail - API for authenticated mailbox to send outbound email.
export const sendEmail = [
  upload.array("attachments"), // Handle files from Postman (form-data)
  asyncHandler(async (req, res) => {
    const { from, to, subject, body } = req.body;
    const senderMailboxId = req.mailbox?.id;

    if (!from || !to || !subject || !body) {
      return ApiError.send(
        res,
        400,
        "Missing required fields: from, to, subject, body"
      );
    }
    if (!senderMailboxId) {
      return ApiError.send(res, 401, "Mailbox authentication required");
    }

    const fromMailbox = await Prisma.mailbox.findFirst({
      where: {
        id: senderMailboxId,
        emailAddress: from.toLowerCase(),
        domain: { status: "VERIFIED" },
      },
      include: {
        domain: { select: { name: true } },
        user: { select: { id: true, email: true } },
      },
    });

    if (!fromMailbox) {
      return ApiError.send(
        res,
        403,
        "Unauthorized sender or domain not verified"
      );
    }

    // Upload email body to S3
    let bodyS3Url;
    try {
      const bodyKey = `emails/sent/${fromMailbox.user.email}/${Date.now()}-body.html`;
      bodyS3Url = await uploadToS3({
        bucket: process.env.EMAIL_BODY_BUCKET,
        key: bodyKey,
        body: Buffer.from(body, "utf-8"),
        contentType: "text/html",
      });
    } catch (err) {
      console.error("S3 upload (body) failed:", err);
      return ApiError.send(res, 500, "Failed to store email body");
    }

    // Upload attachments if any
    let attachmentRecords = [];
    if (req.files && req.files.length > 0) {
      for (let file of req.files) {
        try {
          const attKey = `emails/sent/${fromMailbox.user.email}/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
          await uploadToS3({
            bucket: process.env.ATTACHMENTS_BUCKET,
            key: attKey,
            body: file.buffer,
            contentType: file.mimetype,
          });
          attachmentRecords.push({
            mailboxId: fromMailbox.id, // ✅ added
            userId: fromMailbox.user.id, // ✅ added
            fileName: file.originalname,
            fileSize: file.size,
            mimeType: file.mimetype,
            s3Key: attKey,
            s3Bucket: process.env.ATTACHMENTS_BUCKET,
          });
        } catch (err) {
          console.error("S3 upload (attachment) failed:", err);
        }
      }
    }

    // Prepare attachments for SendGrid
    const sendgridAttachments =
      req.files && req.files.length > 0
        ? req.files.map((file) => ({
            filename: file.originalname,
            content: file.buffer.toString("base64"),
            type: file.mimetype,
            disposition: "attachment",
          }))
        : [];

    // Try sending email
    try {
      await sendViaSendGrid({
        from: { email: from, name: fromMailbox.name || from },
        to,
        subject,
        html: body,
        attachments: sendgridAttachments,
      });
    } catch (err) {
      console.error("sendViaSendGrid error:", err);

      console.log("fromMailbox", fromMailbox);

      // Store FAILED email
      await Prisma.sentEmail.create({
        data: {
          mailboxId: fromMailbox.id,
          userId: fromMailbox.user.id,
          toEmail: Array.isArray(to) ? to[0] || "" : to,
          subject,
          body: bodyS3Url,
          status: "FAILED",
          attachments: { create: attachmentRecords },
        },
      });

      return ApiError.send(res, 500, "Failed to send email");
    }

    console.log(fromMailbox);

    // Store SENT email
    const sent = await Prisma.sentEmail.create({
      data: {
        mailboxId: fromMailbox.id,
        userId: fromMailbox.user.id,
        toEmail: Array.isArray(to) ? to[0] || "" : to,
        subject,
        body: bodyS3Url,
        status: "SENT",
        attachments: { create: attachmentRecords },
      },
    });

    // Create received email record if recipient exists
    const recipient = Array.isArray(to) ? to[0] : to;
    const toMailbox = await Prisma.mailbox.findFirst({
      where: {
        emailAddress: recipient.toLowerCase(),
        domain: { status: "VERIFIED" },
      },
      select: { id: true, userId: true },
    });

    if (toMailbox) {
      await Prisma.receivedEmail.create({
        data: {
          mailboxId: toMailbox.id,
          userId: toMailbox.userId,
          fromEmail: from,
          subject,
          body: bodyS3Url,
          attachments: { create: attachmentRecords },
        },
      });
    }

    return res
      .status(201)
      .json(new ApiResponse(201, "Email sent", { sentId: sent.id }));
  }),
];

// receivedEmail - returns received + sent for a mailbox (mailbox auth required)
export const receivedEmail = asyncHandler(async (req, res) => {
  const mailboxId = req.params.mailboxId;
  const authenticatedMailboxId = req.mailbox?.id;

  if (!authenticatedMailboxId) return ApiError.send(res, 401, "Auth required");
  if (authenticatedMailboxId !== mailboxId && req.user?.role !== "ADMIN") {
    // only owner or admin can view
    return ApiError.send(res, 403, "Forbidden");
  }

  const received = await Prisma.receivedEmail.findMany({
    where: { mailboxId },
    orderBy: { receivedAt: "desc" },
    include: { mailbox: { select: { emailAddress: true } } },
  });

  const sent = await Prisma.sentEmail.findMany({
    where: { mailboxId },
    orderBy: { sentAt: "desc" },
    include: { mailbox: { select: { emailAddress: true } } },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Messages fetched", { received, sent }));
});

// getSingleMessage - fetch one message either from 'sent' or 'received'
export const getSingleEmail = asyncHandler(async (req, res) => {
  const { type, id } = req.params;
  const mailboxAuthId = req.mailbox?.id;

  if (!mailboxAuthId) return ApiError.send(res, 401, "Auth required");

  let message;
  if (type === "sent") {
    message = await Prisma.sentEmail.findFirst({
      where: { id, mailboxId: mailboxAuthId },
      include: { mailbox: { select: { emailAddress: true } } },
    });
  } else if (type === "received") {
    message = await Prisma.receivedEmail.findFirst({
      where: { id, mailboxId: mailboxAuthId },
      include: {
        mailbox: { select: { emailAddress: true } },
        attachments: true,
      },
    });
  } else {
    return ApiError.send(res, 400, "Invalid type param");
  }

  if (!message) return ApiError.send(res, 404, "Message not found");

  return res.status(200).json(new ApiResponse(200, "Message fetched", message));
});

// get all mails
export const getAllMails = asyncHandler(async (req, res) => {
  const mailboxId = req?.mailbox?.id;

  const mailbox = await Prisma.mailbox.findFirst({
    where: { id: mailboxId, deleted: false },
  });

  if (!mailbox) {
    return ApiError.send(res, 404, "Mailbox not found or access denied");
  }

  const received = await Prisma.receivedEmail.findMany({
    where: { mailboxId },
    orderBy: { receivedAt: "desc" },
  });

  const sent = await Prisma.sentEmail.findMany({
    where: { mailboxId },
    orderBy: { sentAt: "desc" },
  });

  return res.status(200).json(
    new ApiResponse(200, "All emails retrieved successfully", {
      sent,
      received,
    })
  );
});

// get sent mails
export const getSentMails = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox.id;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Unauthraized Mailbox User");
  }

  const sendMails = await Prisma.sentEmail.findMany({
    where: { mailboxId, deleted: false, archive: false },
    include: {
      attachments: true,
    },
  });

  if (!sendMails) return ApiError.send(res, 404, "sent mails not found");

  return res
    .status(200)
    .json(new ApiResponse(200, "All sent mails success", sendMails));
});

// get single mail
export const getBySingleMail = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { id } = req.params;

  if (!id) return ApiError.send(res, 400, "Mail ID is required");
  if (!mailboxId) return ApiError.send(res, 401, "Unauthorized Access");

  if (!Prisma?.sentEmail || !Prisma?.receivedEmail)
    return ApiError.send(res, 500, "Prisma models not initialized");

  let mail = await Prisma.sentEmail.findFirst({
    where: { id, mailboxId },
    include: { attachments: true, mailbox: true },
  });

  let type = "sent";

  if (!mail) {
    mail = await Prisma.receivedEmail.findFirst({
      where: { id, toMailboxId: mailboxId },
      include: { attachments: true, mailbox: true },
    });
    type = "received";
  }

  if (!mail) return ApiError.send(res, 404, "Mail not found or access denied");

  const { mailbox: senderMailbox, ...mailSafe } = mail;
  const senderSafe = {
    id: senderMailbox?.id,
    emailAddress: senderMailbox?.emailAddress,
    name: senderMailbox?.name || "",
  };

  return res.status(200).json({
    success: true,
    type,
    data: { ...mailSafe, sender: senderSafe },
  });
});

// delete send or receiced mail
export const deleteMail = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { id } = req.params;

  if (!id) return ApiError.send(res, 400, "Mail ID is required");
  if (!mailboxId) return ApiError.send(res, 401, "Unauthorized Access");

  if (!Prisma?.sentEmail || !Prisma?.receivedEmail)
    return ApiError.send(res, 500, "Prisma models not initialized");

  let mail = await Prisma.sentEmail.findFirst({
    where: { id, mailboxId },
    include: { attachments: true, mailbox: true },
  });

  let type = "sent";

  if (!mail) {
    mail = await Prisma.receivedEmail.findFirst({
      where: { id, mailboxId: mailboxId },
      include: { attachments: true, mailbox: true },
    });
    type = "received";
  }

  if (!mail) return ApiError.send(res, 404, "Mail not found or access denied");

  if (mail.attachments?.length) {
    await Prisma.attachment.deleteMany({
      where: { emailId: mail.id },
    });
  }

  if (type === "sent") {
    await Prisma.sentEmail.delete({
      where: { id: mail.id },
    });
  } else {
    await Prisma.receivedEmail.delete({
      where: { id: mail.id },
    });
  }

  return res.status(200).json({
    success: true,
    message: `Mail (${type}) deleted successfully`,
    id: mail.id,
  });
});

// bulk mail delete
export const bulkMailDelete = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { mailsId } = req.body;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox not found");
  }

  if (!mailsId || !Array.isArray(mailsId) || mailsId.length === 0) {
    return ApiError.send(res, 400, "No mail IDs provided");
  }

  const deletedSent = await Prisma.sentEmail.deleteMany({
    where: {
      id: { in: mailsId },
      mailboxId: mailboxId,
    },
  });

  const deletedReceived = await Prisma.receivedEmail.deleteMany({
    where: {
      id: { in: mailsId },
      mailboxId: mailboxId,
    },
  });

  if (deletedSent.count === 0 && deletedReceived.count === 0) {
    return ApiError.send(res, 404, "No matching mails found to delete");
  }

  return res.json({
    message: "Mails deleted successfully",
    deleted: {
      sent: deletedSent.count,
      received: deletedReceived.count,
    },
  });
});

// move to trash (single + bulk)
export const moveToTrash = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { mailId, mailsId } = req.body;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox not found");
  }

  // decide single or bulk
  const ids =
    mailsId && Array.isArray(mailsId) && mailsId.length > 0
      ? mailsId
      : mailId
        ? [mailId]
        : null;

  if (!ids) {
    return ApiError.send(res, 400, "No mail ID(s) provided");
  }

  // sent mails
  const deletedSent = await Prisma.sentEmail.updateMany({
    where: {
      id: { in: ids },
      mailboxId,
      deleted: false,
    },
    data: { deleted: true },
  });

  // received mails
  const deletedReceived = await Prisma.receivedEmail.updateMany({
    where: {
      id: { in: ids },
      mailboxId,
      deleted: false,
    },
    data: { deleted: true },
  });

  if (deletedSent.count === 0 && deletedReceived.count === 0) {
    return ApiError.send(
      res,
      404,
      "No matching mail(s) found to move to trash"
    );
  }

  return res.json({
    message: "Mail(s) moved to trash successfully",
    deleted: {
      sent: deletedSent.count,
      received: deletedReceived.count,
      total: deletedSent.count + deletedReceived.count,
    },
  });
});

// move to archive (only single)
export const moveToArchive = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { mailId } = req.body;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox not found");
  }

  if (!mailId) {
    return ApiError.send(res, 400, "No mail ID provided");
  }

  const archivedSent = await Prisma.sentEmail.updateMany({
    where: {
      id: mailId,
      mailboxId,
      archive: false,
    },
    data: { archive: true },
  });

  const archivedReceived = await Prisma.receivedEmail.updateMany({
    where: {
      id: mailId,
      mailboxId,
      archive: false,
    },
    data: { archive: true },
  });

  if (archivedSent.count === 0 && archivedReceived.count === 0) {
    return ApiError.send(res, 404, "No matching mail found to archive");
  }

  return res.json({
    message: "Mail archived successfully",
    archived: {
      sent: archivedSent.count,
      received: archivedReceived.count,
    },
  });
});

// getTrashMails (sent + received only trash)
export const getTrashMails = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox not found");
  }

  const trashedSent = await Prisma.sentEmail.findMany({
    where: {
      mailboxId,
      deleted: true,
    },
    orderBy: { sentAt: "desc" },
  });

  const trashedReceived = await Prisma.receivedEmail.findMany({
    where: {
      mailboxId,
      deleted: true,
    },
    orderBy: { receivedAt: "desc" },
  });

  const trashMails = [
    ...trashedSent.map((m) => ({ ...m, type: "SENT" })),
    ...trashedReceived.map((m) => ({ ...m, type: "RECEIVED" })),
  ];

  // Sort by latest date
  trashMails.sort((a, b) => {
    const dateA = new Date(a.sentAt || a.receivedAt);
    const dateB = new Date(b.sentAt || b.receivedAt);
    return dateB - dateA;
  });

  return res.json({
    trash: trashMails,
  });
});
