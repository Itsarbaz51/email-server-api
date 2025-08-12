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
      throw new ApiError(400, "Missing required fields: from, to, subject, body");
    }
    if (!senderMailboxId) {
      throw new ApiError(401, "Mailbox authentication required");
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
      throw new ApiError(403, "Unauthorized sender or domain not verified");
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
      throw new ApiError(500, "Failed to store email body");
    }

    // Upload attachments if any
    let attachmentRecords = [];
    if (req.files && req.files.length > 0) {
      for (let file of req.files) {
        try {
          const attKey = `emails/sent/${fromMailbox.user.id}/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
          await uploadToS3({
            bucket: process.env.ATTACHMENTS_BUCKET,
            key: attKey,
            body: file.buffer,
            contentType: file.mimetype,
          });
          attachmentRecords.push({
            fileName: file.originalname,
            fileSizeMB: Math.round(file.size / (1024 * 1024)),
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
    const sendgridAttachments = req.files && req.files.length > 0
      ? req.files.map(file => ({
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

      // Store FAILED email
      await Prisma.sentEmail.create({
        data: {
          mailbox: { connect: { id: fromMailbox.id } },
          user: { connect: { id: fromMailbox.user.id } },
          toEmail: Array.isArray(to) ? (to[0] || "") : to,
          subject,
          body: bodyS3Url,
          status: "FAILED",
          attachments: { create: attachmentRecords },
        },
      });

      throw new ApiError(500, "Failed to send email");
    }

    // Store SENT email
    const sent = await Prisma.sentEmail.create({
      data: {
        mailbox: { connect: { id: fromMailbox.id } },
        user: { connect: { id: fromMailbox.user.id } },
        toEmail: Array.isArray(to) ? (to[0] || "") : to,
        subject,
        body: bodyS3Url,
        status: "SENT",
        attachments: { create: attachmentRecords },
      },
    });

    // Create received email record if recipient exists
    const recipient = Array.isArray(to) ? to[0] : to;
    const toMailbox = await Prisma.mailbox.findFirst({
      where: { emailAddress: recipient.toLowerCase(), domain: { status: "VERIFIED" } },
      select: { id: true, userId: true },
    });

    if (toMailbox) {
      await Prisma.receivedEmail.create({
        data: {
          mailbox: { connect: { id: toMailbox.id } },
          user: { connect: { id: toMailbox.userId } },
          fromEmail: from,
          subject,
          body: bodyS3Url,
          attachments: { create: attachmentRecords },
        },
      });
    }

    return res.status(201).json(new ApiResponse(201, "Email sent", { sentId: sent.id }));
  }),
];



// receivedEmail - returns received + sent for a mailbox (mailbox auth required)
export const receivedEmail = asyncHandler(async (req, res) => {
  const mailboxId = req.params.mailboxId;
  const authenticatedMailboxId = req.mailbox?.id;

  if (!authenticatedMailboxId) throw new ApiError(401, "Auth required");
  if (authenticatedMailboxId !== mailboxId && req.user?.role !== "ADMIN") {
    // only owner or admin can view
    throw new ApiError(403, "Forbidden");
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

  return res.status(200).json(new ApiResponse(200, "Messages fetched", { received, sent }));
});


// getSingleMessage - fetch one message either from 'sent' or 'received'
export const getSingleEmail = asyncHandler(async (req, res) => {
  const { type, id } = req.params;
  const mailboxAuthId = req.mailbox?.id;

  if (!mailboxAuthId) throw new ApiError(401, "Auth required");

  let message;
  if (type === "sent") {
    message = await Prisma.sentEmail.findFirst({
      where: { id, mailboxId: mailboxAuthId },
      include: { mailbox: { select: { emailAddress: true } } },
    });
  } else if (type === "received") {
    message = await Prisma.receivedEmail.findFirst({
      where: { id, mailboxId: mailboxAuthId },
      include: { mailbox: { select: { emailAddress: true } }, attachments: true },
    });
  } else {
    throw new ApiError(400, "Invalid type param");
  }

  if (!message) throw new ApiError(404, "Message not found");

  return res.status(200).json(new ApiResponse(200, "Message fetched", message));
});

// get all mails
export const getAllMails = asyncHandler(async (req, res) => {
    const { mailboxId } = req.params;
    const userId = req.user?.id; // assuming middleware sets req.user
  
    if (!userId) {
      throw new ApiError(401, "Authentication required");
    }
  
    // ✅ Check if mailbox belongs to the logged-in user
    const mailbox = await Prisma.mailbox.findFirst({
      where: { id: mailboxId, userId },
    });
    if (!mailbox) {
      throw new ApiError(404, "Mailbox not found or access denied");
    }
  
    // 📩 Fetch received emails
    const received = await Prisma.receivedEmail.findMany({
      where: { mailboxId, userId },
      orderBy: { receivedAt: "desc" },
    });
  
    // 📤 Fetch sent emails
    const sent = await Prisma.sentEmail.findMany({
      where: { mailboxId, userId },
      orderBy: { sentAt: "desc" },
    });
  
    return res.status(200).json(
      new ApiResponse(200, "All emails retrieved successfully", {
        sent,
        received,
      })
    );
  });
  