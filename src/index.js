import dotenv from "dotenv";
import app from "./app.js";
import { incomingServer } from "./services/smtpServer.js"
import Prisma from "./db/db.js";

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