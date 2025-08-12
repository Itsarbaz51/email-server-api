import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import Prisma from "../db/db.js";
import { uploadToS3, generateS3Key } from "../services/s3Service.js";
import { verifySubscription } from "../middlewares/subscription.middleware.js";

const maxEmailSize = Number(process.env.MAX_EMAIL_SIZE_BYTES) || 25 * 1024 * 1024; // 25MB
const attachmentsBucket = process.env.ATTACHMENTS_BUCKET;

if (!attachmentsBucket) {
  console.error("❌ ATTACHMENTS_BUCKET env variable is missing. Attachments upload will fail.");
}

export const incomingServer = new SMTPServer({
  authOptional: true,
  allowInsecureAuth: true,
  size: maxEmailSize,

  onConnect(session, callback) {
    console.log(`📩 SMTP client connected from ${session.remoteAddress}`);
    callback();
  },

  async onMailFrom(address, session, callback) {
    if (!address?.address) {
      return callback(new Error("Invalid MAIL FROM"));
    }
    callback();
  },

  async onRcptTo(address, session, callback) {
    if (!address?.address) {
      return callback(new Error("Invalid RCPT TO"));
    }

    try {
      const mailbox = await Prisma.mailbox.findFirst({
        where: {
          emailAddress: address.address.toLowerCase(),
          domain: { status: "VERIFIED" },
        },
        select: { id: true },
      });

      // Check subscription
      await verifySubscription(mailbox.userId, "receiveMail");

      if (!mailbox) {
        return callback(new Error("Mailbox not found or domain unverified"));
      }
      callback();
    } catch (err) {
      console.error("❌ onRcptTo DB error:", err);
      callback(new Error("Temporary server error"));
    }
  },

  onData(stream, session, callback) {
    let chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxEmailSize) {
        stream.destroy(new Error("Email size exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });

    stream.on("error", (err) => {
      console.error("❌ SMTP stream error:", err);
    });

    stream.on("end", async () => {
      try {
        const rawEmail = Buffer.concat(chunks);
        if (!rawEmail.length) {
          return callback(new Error("Empty email"));
        }

        const parsed = await simpleParser(rawEmail);

        const fromAddress =
          session.envelope?.mailFrom?.address ||
          parsed.from?.value?.[0]?.address ||
          null;

        if (!fromAddress) {
          return callback(new Error("Missing sender address"));
        }

        for (const rcpt of session.envelope.rcptTo || []) {
          const toAddress = (rcpt.address || "").toLowerCase();

          const mailbox = await Prisma.mailbox.findFirst({
            where: {
              emailAddress: toAddress,
              domain: { status: "VERIFIED" },
            },
            select: { id: true, userId: true },
          });

          if (!mailbox) continue;

          

          // Save received email
          const received = await Prisma.receivedEmail.create({
            data: {
              mailboxId: mailbox.id,
              userId: mailbox.userId,
              fromEmail: fromAddress,
              body: parsed.text || parsed.html || "",
              receivedAt: new Date(),
              subject: parsed.subject || "(No Subject)",
              messageId: parsed.messageId || null, // ✅ Store Gmail/SMTP message ID
            },
          });

          // Process attachments
          if (parsed.attachments?.length) {
            for (const att of parsed.attachments) {
              const filename = att.filename || "attachment";
              const cleanName = filename.replace(/\s+/g, "_");
              const s3Key = generateS3Key("attachments", cleanName);

              try {
                await uploadToS3({
                  bucket: attachmentsBucket,
                  key: s3Key,
                  body: att.content,
                  contentType: att.contentType || "application/octet-stream",
                });

                await Prisma.attachment.create({
                  data: {
                    mailboxId: mailbox.id,
                    userId: mailbox.userId,
                    emailId: received.id,
                    fileName: cleanName,
                    fileSizeMB: Math.round(
                      (att.size || att.content?.length || 0) / (1024 * 1024)
                    ),
                    mimeType: att.contentType || "application/octet-stream",
                    s3Key,
                    s3Bucket: attachmentsBucket,
                  },
                });
              } catch (err) {
                console.error(`❌ Failed to upload attachment ${filename}:`, err);
              }
            }
          }

          console.log(`✅ Email stored: id=${received.id} to=${toAddress}`);
        }

        callback();
      } catch (err) {
        console.error("❌ SMTP parse/store error:", err);
        callback(new Error("Failed to process email"));
      }
    });
  },
});
