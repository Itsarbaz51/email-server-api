import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import Prisma from "../db/db.js";
import { sendViaSendGrid } from "../services/sendgridService.js";
import { uploadToS3, getPresignedUrl } from "../services/s3Service.js";
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
  const mailboxId = req.mailbox?.id;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Unauthraized mailbox user");
  }

  const received = await Prisma.receivedEmail.findMany({
    where: { mailboxId, deleted: false, archive: false },
    include: {
      attachments: true,
    },
    orderBy: { receivedAt: "desc" },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Messages fetched", received));
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
    const existsMail = await Prisma.receivedEmail.findFirst({
      where: { id, mailboxId: mailboxAuthId, isRead: true },
    });

    if (!existsMail) {
      console.log("Email not found or already unread.");
      return ApiError.send(res, 404, "Message not found");
    }

    // ❌ FIXED: Don't redeclare 'message' — just assign to the outer one
    message = await Prisma.receivedEmail.update({
      where: { id: existsMail.id },
      data: { isRead: false },
      include: {
        mailbox: { select: { emailAddress: true } },
        attachments: true,
      },
    });

    console.log("Updated message:", message);
  } else {
    return ApiError.send(res, 400, "Invalid type param");
  }

  if (!message) return ApiError.send(res, 404, "Message not found");

  return res.status(200).json(new ApiResponse(200, "Message fetched", message));
});

// get all mails (combined sent + received)
export const getAllMails = asyncHandler(async (req, res) => {
  const mailboxId = req?.mailbox?.id;

  const mailbox = await Prisma.mailbox.findFirst({
    where: { id: mailboxId },
  });

  if (!mailbox) {
    return ApiError.send(res, 404, "Mailbox not found or access denied");
  }

  // Received mails
  const received = await Prisma.receivedEmail.findMany({
    where: { mailboxId, deleted: false },
  });

  // Sent mails
  const sent = await Prisma.sentEmail.findMany({
    where: { mailboxId, deleted: false },
  });

  // Combine both arrays
  const allMails = [
    ...received.map((mail) => ({
      ...mail,
      type: "received",
      date: mail.receivedAt,
    })),
    ...sent.map((mail) => ({ ...mail, type: "sent", date: mail.sentAt })),
  ];

  // Sort by date descending (latest first)
  allMails.sort((a, b) => new Date(b.date) - new Date(a.date));

  return res
    .status(200)
    .json(new ApiResponse(200, "All emails retrieved successfully", allMails));
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
    orderBy: { sentAt: "desc" },
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

  // Check Sent Emails
  let mail = await Prisma.sentEmail.findFirst({
    where: { id, mailboxId },
    include: { attachments: true, mailbox: true },
  });

  let type = "sent";

  // If not found in sent, check Received Emails
  if (!mail) {
    mail = await Prisma.receivedEmail.findFirst({
      where: { id, mailboxId },
      include: { attachments: true, mailbox: true },
    });

    if (mail) {
      // Mark as unread (isRead = false)
      if (mail.isRead) {
        await Prisma.receivedEmail.update({
          where: { id: mail.id },
          data: { isRead: false },
        });
        mail.isRead = false; // reflect in response
      }
      type = "received";
    }
  }

  if (!mail) return ApiError.send(res, 404, "Mail not found or access denied");

  // Remove sensitive mailbox info
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

  const ids =
    mailsId && Array.isArray(mailsId) && mailsId.length > 0
      ? mailsId
      : mailId
        ? [mailId]
        : null;

  if (!ids) {
    return ApiError.send(res, 400, "No mail ID(s) provided");
  }

  // Sent mails
  const deletedSent = await Prisma.sentEmail.updateMany({
    where: {
      id: { in: ids },
      mailboxId,
      deleted: false,
    },
    data: { deleted: true },
  });

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

  let data = null;

  // Try sent mail first
  const sentMail = await Prisma.sentEmail.findFirst({
    where: { id: mailId, mailboxId, archive: false },
  });

  if (sentMail) {
    data = await Prisma.sentEmail.update({
      where: { id: mailId },
      data: { archive: true },
    });
  } else {
    const receivedMail = await Prisma.receivedEmail.findFirst({
      where: { id: mailId, mailboxId, archive: false },
    });

    if (receivedMail) {
      data = await Prisma.receivedEmail.update({
        where: { id: mailId },
        data: { archive: true },
      });
    }
  }

  if (!data) {
    return ApiError.send(res, 404, "No matching mail found to archive");
  }

  return res.json({
    message: "Mail archived successfully",
    data,
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

  return res
    .status(200)
    .json(new ApiResponse(200, "All Tarsh mails success", trashMails));
});

export const getArchiveMails = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox not found");
  }

  const archivedSent = await Prisma.sentEmail.findMany({
    where: {
      mailboxId,
      archive: true,
    },
    orderBy: { sentAt: "desc" },
  });

  const archivedReceived = await Prisma.receivedEmail.findMany({
    where: {
      mailboxId,
      archive: true,
    },
    orderBy: { receivedAt: "desc" },
  });

  const archiveMails = [
    ...archivedSent.map((m) => ({ ...m, type: "SENT" })),
    ...archivedReceived.map((m) => ({ ...m, type: "RECEIVED" })),
  ];

  // Sort by latest date
  archiveMails.sort((a, b) => {
    const dateA = new Date(a.sentAt || a.receivedAt);
    const dateB = new Date(b.sentAt || b.receivedAt);
    return dateB - dateA;
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "All Archive mails success", archiveMails));
});

// add starred
export const addStarred = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { mailId } = req.params;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox user unauthorized");
  }

  let mail = null;

  let sentMail = await Prisma.sentEmail.findUnique({
    where: { id: mailId, mailboxId },
  });

  let receivedMail = await Prisma.receivedEmail.findUnique({
    where: { id: mailId, mailboxId },
  });

  if (!sentMail && !receivedMail) {
    return ApiError.send(res, 404, "Mail not found");
  }

  if (sentMail) {
    mail = await Prisma.sentEmail.update({
      where: { id: mailId },
      data: { starred: true },
    });
  }

  if (receivedMail) {
    mail = await Prisma.receivedEmail.update({
      where: { id: mailId },
      data: { starred: true },
    });
  }

  return res.json({
    message: "Mail starred successfully",
    data: mail,
  });
});

// remove starred
export const removeStarred = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { mailId } = req.params;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox user unauthorized");
  }

  let mail = null;

  // Check in sent mails
  let sentMail = await Prisma.sentEmail.findUnique({
    where: { id: mailId, mailboxId },
  });

  // Check in received mails
  let receivedMail = await Prisma.receivedEmail.findUnique({
    where: { id: mailId, mailboxId },
  });

  if (!sentMail && !receivedMail) {
    return ApiError.send(res, 404, "Mail not found");
  }

  if (sentMail) {
    mail = await Prisma.sentEmail.update({
      where: { id: mailId },
      data: { starred: false },
    });
  }

  if (receivedMail) {
    mail = await Prisma.receivedEmail.update({
      where: { id: mailId },
      data: { starred: false },
    });
  }

  return res.json({
    message: "Mail unstarred successfully",
    data: mail,
  });
});

// get all starred
export const getAllStarred = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox user unauthorized");
  }

  const [starredSent, starredReceived] = await Promise.all([
    Prisma.sentEmail.findMany({
      where: { mailboxId, starred: true },
    }),
    Prisma.receivedEmail.findMany({
      where: { mailboxId, starred: true },
    }),
  ]);

  const data = [...starredSent, ...starredReceived];

  return res
    .status(200)
    .json(new ApiResponse(200, "success get all starred", data));
});

// get email body data on s3
export const getEmailBody = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;
  const { emailId, type } = req.params;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Mailbox not found");
  }

  if (!emailId || !["SENT", "RECEIVED"].includes(type)) {
    return ApiError.send(res, 400, "Invalid email type or ID");
  }

  let emailRecord;
  if (type === "SENT") {
    emailRecord = await Prisma.sentEmail.findFirst({
      where: { id: emailId, mailboxId },
      include: { attachments: true },
    });
  } else {
    emailRecord = await Prisma.receivedEmail.findFirst({
      where: { id: emailId, mailboxId },
      include: { attachments: true },
    });
  }

  if (!emailRecord) {
    return ApiError.send(res, 404, "Email not found");
  }

  const s3Key = emailRecord.body;
  if (!s3Key) {
    return ApiError.send(res, 404, "Email body not stored");
  }

  try {
    const presignedUrl = await getPresignedUrl(
      process.env.EMAIL_BODY_BUCKET,
      s3Key,
      300
    );

    console.log(emailRecord);

    let attachments = [];
    if (emailRecord.attachments?.length) {
      attachments = await Promise.all(
        emailRecord.attachments.map(async (att) => {
          const url = await getPresignedUrl(
            process.env.ATTACHMENTS_BUCKET,
            att.s3Key,
            300
          );
          return {
            id: att.id,
            name: att.name,
            type: att.type,
            size: att.size,
            url,
          };
        })
      );
    }
    console.log(attachments);

    return res.status(200).json(
      new ApiResponse(200, "Email body URL generated", {
        emailId,
        type,
        bodyUrl: presignedUrl,
        attachments,
      })
    );
  } catch (err) {
    console.error("Presigned URL generation failed:", err);
    return ApiError.send(res, 500, "Failed to fetch email body");
  }
});


////////////////////////// sidebar inbox count ///////////////////////////////////
export const allNewReceivedEmailCount = asyncHandler(async (req, res) => {
  const mailboxId = req.mailbox?.id;

  if (!mailboxId) {
    return ApiError.send(res, 401, "Unauthorized user");
  }

  const newMailsReceived = await Prisma.receivedEmail.count({
    where: { mailboxId, isRead: true }
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "received count fetched", { count: newMailsReceived }));
});
