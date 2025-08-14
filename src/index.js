import dotenv from "dotenv";
import app from "./app.js";
import { incomingServer } from "./services/smtpServer.js";
import Prisma from "./db/db.js";
import https from "https";
import fs from "fs";

dotenv.config({ path: "./.env" });

(async function main() {
  try {
    console.log("Connecting to database...");
    await Prisma.$connect();
    console.log("✅ Database connected");

    // SMTP server start
    incomingServer.listen(25, "0.0.0.0", () => {
      console.log("🚀 SMTP server running on port 25");
    });

    // Read SSL certs
    const key = fs.readFileSync("./localhost+2-key.pem");
    const cert = fs.readFileSync("./localhost+2.pem");

    // HTTPS server start
    https.createServer({ key, cert }, app).listen(3000, "0.0.0.0", () => {
      console.log("🚀 HTTPS server running on https://localhost:3000");
    });
  } catch (error) {
    console.error("❌ Server startup failed:", error);
    process.exit(1);
  }
})();
