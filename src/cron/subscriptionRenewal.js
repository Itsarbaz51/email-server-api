// src/cron/subscriptionRenewal.js
import cron from "node-cron";
import Prisma from "../db/db.js";
import { generateInvoiceId } from "../utils/lib.js";

cron.schedule("* * * * * *", async () => {
  // 🔄 This will run daily at midnight instead of every second
  console.log("⏰ Cron started - Checking subscriptions...");

  try {
    const today = new Date();

    // Find all active subscriptions ending today or earlier
    const expiringSubs = await Prisma.subscription.findMany({
      where: {
        endDate: { lte: today },
        isActive: true,
      },
    });

    if (expiringSubs.length === 0) {
      console.log("✅ No subscriptions expiring today.");
      return;
    }

    for (const sub of expiringSubs) {
      try {
        // 💰 Calculate amount based on plan
        let amount = 0;
        if (sub.plan === "BASIC") amount = 5 * 87;
        else if (sub.plan === "PREMIUM") amount = 15 * 87;

        // 📄 Generate invoice
        const invoice = await Prisma.invoice.create({
          data: {
            invoiceId: generateInvoiceId(),
            subscriptionId: sub.id,
            amount,
            status: "PENDING", // Payment gateway webhook ke baad "PAID" hoga
          },
        });

        // 📆 Calculate new billing dates
        const nextStartDate = new Date(sub.endDate);
        const nextEndDate = new Date(nextStartDate);

        if (sub.billingCycle === "MONTHLY") {
          nextEndDate.setMonth(nextEndDate.getMonth() + 1);
        } else if (sub.billingCycle === "YEARLY") {
          nextEndDate.setFullYear(nextEndDate.getFullYear() + 1);
        }

        // 🔄 Update subscription
        await Prisma.subscription.update({
          where: { id: sub.id },
          data: {
            startDate: nextStartDate,
            endDate: nextEndDate,
          },
        });

        console.log(
          `📄 Invoice #${invoice.invoiceId} generated & subscription renewed for user: ${sub.userId}`
        );
      } catch (err) {
        console.error(
          `❌ Failed to process subscription ${sub.id} (user ${sub.userId}):`,
          err.message
        );
      }
    }
  } catch (error) {
    console.error("🚨 Error in subscription renewal cron:", error.message);
  }
});
