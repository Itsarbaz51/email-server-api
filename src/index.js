import dotenv from "dotenv";
import app from "./app.js";
import { incomingServer } from "./services/smtpServer.js";
import Prisma from "./db/db.js";
import "./cron/subscriptionRenewal.js";
import { autoVerifyDomains } from "./controllers/domain.controller.js";
import cron from "node-cron";

dotenv.config({ path: "./.env" });

(async function main() {
  try {
    try {
      console.log("Connecting to database...");
      await Prisma.$connect();
      console.log("✅ Database connected");
    } catch (error) {
      console.error("❌ DB connection error:", error);
    }

    //  30 mins run for dns records verify
    cron.schedule("0 * * * *", autoVerifyDomains);
    console.log("⏰ Cron job scheduled: Domain verification every 30 minutes");

    incomingServer.listen(25, "0.0.0.0", () => {
      console.log("🚀 SMTP server running on port 25");
    });

    app.listen(3000, "0.0.0.0", () => {
      console.log("🚀 HTTP server running on port 3000");
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
})();
