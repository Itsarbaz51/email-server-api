// smtp/incomingServer.js
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import Prisma from "../db/db.js";
import { uploadToS3, generateS3Key } from "../services/s3Service.js";

const maxEmailSize = Number(process.env.MAX_EMAIL_SIZE_BYTES) || 25 * 1024 * 1024; // 25MB
const attachmentsBucket = process.env.ATTACHMENTS_BUCKET;

if (!attachmentsBucket) {
  console.warn("⚠️ ATTACHMENTS_BUCKET is not set. Attachments will fail to upload.");
}

export const incomingServer = new SMTPServer({
  authOptional: true,
  allowInsecureAuth: true,
  size: maxEmailSize,

  onConnect(session, callback) {
    console.log(`📩 SMTP client connected from ${session.remoteAddress}`);
    callback();
  },

  onMailFrom(address, session, callback) {
    if (!address?.address) {
      return callback(new Error("Invalid MAIL FROM"));
    }
    console.log("MAIL FROM:", address.address);
    callback();
  },

  async onRcptTo(address, session, callback) {
    if (!address?.address) {
      return callback(new Error("Invalid RCPT TO"));
    }
    console.log("RCPT TO:", address.address);
    callback();
  },

  onData(stream, session, callback) {
    let chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxEmailSize) {
        console.error("❌ Email too large");
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
          return callback(new Error("Missing sender"));
        }

        for (const rcpt of session.envelope.rcptTo || []) {
          const toAddress = (rcpt.address || "").toLowerCase();

          const mailbox = await Prisma.mailbox.findFirst({
            where: {
              emailAddress: toAddress,
              domain: { verified: true },
            },
            select: { id: true, userId: true },
          });

          if (!mailbox) {
            console.log(`📭 No mailbox found or domain unverified: ${toAddress}`);
            continue;
          }

          const received = await Prisma.receivedEmail.create({
            data: {
              mailboxId: mailbox.id,
              userId: mailbox.userId,
              fromEmail: fromAddress,
              subject: parsed.subject || "(No Subject)",
              textBody: parsed.text || "",
              htmlBody: parsed.html || "",
            },
          });

          if (parsed.attachments?.length) {
            for (const att of parsed.attachments) {
              const filename = att.filename || "attachment";
              const s3Key = generateS3Key("attachments", filename.replace(/\s+/g, "_"));

              try {
                await uploadToS3({
                  bucket: attachmentsBucket,
                  key: s3Key,
                  body: att.content,
                  contentType: att.contentType || "application/octet-stream",
                });

                const s3Url = `https://${attachmentsBucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

                await Prisma.attachment.create({
                  data: {
                    mailboxId: mailbox.id,
                    userId: mailbox.userId,
                    emailId: received.id,
                    fileName: filename,
                    fileSizeKB: Math.ceil((att.size || att.content?.length || 0) / 1024),
                    mimeType: att.contentType || "application/octet-stream",
                    s3Key,
                    s3Bucket: attachmentsBucket,
                    s3Url,
                  },
                });
              } catch (err) {
                console.error(`❌ Failed to upload attachment ${filename}:`, err);
              }
            }
          }

          console.log(`✅ Stored email id=${received.id} for ${toAddress}`);
        }

        callback();
      } catch (err) {
        console.error("❌ SMTP parse/store error:", err);
        callback(new Error("Failed to process email"));
      }
    });
  },
});
