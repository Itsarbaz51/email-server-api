// src/services/smtpServer.js
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import Prisma from "../db/db.js";
import { uploadToS3, generateS3Key } from "../services/s3Service.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const MAX_EMAIL_SIZE =
  Number(process.env.MAX_EMAIL_SIZE_BYTES) || 25 * 1024 * 1024; // 25MB
const EMAIL_BODY_BUCKET = process.env.EMAIL_BODY_BUCKET;
const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET;

if (!EMAIL_BODY_BUCKET) {
  console.warn(
    "⚠️ EMAIL_BODY_BUCKET not set — body uploads will fail or fallback to inline storage."
  );
}
if (!ATTACHMENTS_BUCKET) {
  console.warn("⚠️ ATTACHMENTS_BUCKET not set — attachment uploads will fail.");
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  else return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Local subscription check for SMTP context.
 * Throws ApiError on failure.
 */

export const incomingServer = new SMTPServer({
  authOptional: true,
  allowInsecureAuth: true,
  size: MAX_EMAIL_SIZE,

  async onConnect(session, callback) {
    console.log("📩 SMTP connected from", session.remoteAddress);
    return callback();
  },

  async onMailFrom(address, session, callback) {
    if (!address?.address) return callback(new Error("Invalid MAIL FROM"));
    return callback();
  },

  async onRcptTo(address, session, callback) {
    if (!address?.address) return callback(new Error("Invalid RCPT TO"));

    const rcpt = address.address.toLowerCase();
    try {
      const mailbox = await Prisma.mailbox.findFirst({
        where: { emailAddress: rcpt, domain: { status: "VERIFIED" } },
        select: { id: true, userId: true },
      });

      if (!mailbox)
        return callback(new Error("Mailbox not found or domain unverified"));

      // subscription check (throws ApiError if invalid)
      await verifySubscription(mailbox.userId, "receiveMail");

      return callback(); // accept recipient
    } catch (err) {
      console.error("❌ onRcptTo error:", err?.message || err);
      return callback(new Error(err?.message || "Temporary server error"));
    }
  },

  async onData(stream, session, callback) {
    const chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_EMAIL_SIZE) {
        stream.destroy(new Error("Email size exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });

    stream.on("error", (err) => {
      console.error("SMTP stream error:", err);
    });

    stream.on("end", async () => {
      try {
        const raw = Buffer.concat(chunks);
        if (!raw || raw.length === 0)
          return callback(new Error("Empty email payload"));

        const parsed = await simpleParser(raw);

        const fromAddress =
          session.envelope?.mailFrom?.address ||
          parsed.from?.value?.[0]?.address ||
          null;
        if (!fromAddress) return callback(new Error("Missing sender address"));

        const recipients = (session.envelope?.rcptTo || []).map((r) =>
          (r.address || "").toLowerCase()
        );
        if (!recipients.length) return callback(new Error("No recipients"));

        for (const toAddress of recipients) {
          try {
            const mailbox = await Prisma.mailbox.findFirst({
              where: {
                emailAddress: toAddress,
                domain: { status: "VERIFIED" },
              },
              include: {
                user: { select: { id: true, email: true } },
                domain: { select: { name: true } },
              },
            });
            if (!mailbox) {
              console.log(
                `📭 Skip recipient (not found / domain unverified): ${toAddress}`
              );
              continue;
            }

            // subscription check (again, safe)
            await verifySubscription(mailbox.userId, "receiveMail");

            // Save body to S3 if bucket set, else fallback to inline
            let bodyReference;
            try {
              const emailBody = parsed.html || parsed.text;
              const bodyKey = `emails/received/${mailbox.user.email}/${Date.now()}-body.html`;
              bodyReference = await uploadToS3({
                bucket: EMAIL_BODY_BUCKET,
                key: bodyKey,
                body: Buffer.from(emailBody, "utf-8"),
                contentType: "text/html",
              });
            } catch (s3Err) {
              console.warn(
                "S3 body upload failed, storing inline body:",
                s3Err?.message || s3Err
              );
              return ApiError.send(
                res,
                500,
                "Failed to store email body smtp",
                bodyReference
              );
            }

            // Create received email record
            const received = await Prisma.receivedEmail.create({
              data: {
                mailboxId: mailbox.id,
                userId: mailbox.userId,
                fromEmail: fromAddress,
                subject: parsed.subject || "(No Subject)",
                body: bodyReference,
                isRead: true,
                messageId: parsed.messageId || null,
                status: "RECEIVED",
                receivedAt: new Date(),
              },
            });

            // Process attachments (if any)
            if (parsed.attachments?.length && ATTACHMENTS_BUCKET) {
              for (const att of parsed.attachments) {
                try {
                  const filename = att.filename || "attachment";
                  const clean = filename.replace(/\s+/g, "_");
                  const s3Key = generateS3Key("received", clean);

                  await uploadToS3({
                    bucket: ATTACHMENTS_BUCKET,
                    key: s3Key,
                    body: att.content,
                    contentType: att.contentType || "application/octet-stream",
                  });
                  
                  console.log("att", att);
                  await Prisma.attachment.create({
                    data: {
                      mailboxId: mailbox.id,
                      userId: mailbox.userId,
                      receivedEmailId: received.id,
                      fileName: clean,
                      fileSize: formatFileSize(att.size || att.content?.length || 0),
                      mimeType: att.contentType || "application/octet-stream",
                      s3Key,
                      s3Bucket: ATTACHMENTS_BUCKET,
                    },
                  });
                } catch (attErr) {
                  console.error(
                    `❌ Attachment error for ${mailbox.id}:`,
                    attErr?.message || attErr
                  );
                  // continue attachments
                }
              }
            } else if (parsed.attachments?.length && !ATTACHMENTS_BUCKET) {
              console.warn(
                "Attachments present but ATTACHMENTS_BUCKET not configured — skipping attachments upload."
              );
            }

            console.log(
              `✅ Stored received email id=${received.id} for ${toAddress}`
            );
          } catch (recipientErr) {
            console.error(
              `❌ Failed processing recipient ${toAddress}:`,
              recipientErr?.message || recipientErr
            );
            // continue with other recipients
          }
        }

        return callback();
      } catch (err) {
        console.error("❌ SMTP parse/store error:", err?.message || err);
        return callback(new Error("Failed to process email"));
      }
    });
  },
});
