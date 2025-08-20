import cron from "node-cron";
import Prisma from "../db/db.js";
import { generateInvoiceId } from "../utils/lib.js";

cron.schedule("0 0 * * *", async () => {
    console.log("🔄 Running daily subscription renewal check...");

    const today = new Date();

    const expiringSubs = await Prisma.subscription.findMany({
        where: {
            endDate: { lte: today },
            isActive: true,
        },
    });

    for (const sub of expiringSubs) {
        let amount = 0;
        if (sub.plan === "BASIC") amount = 5 * 83;
        else if (sub.plan === "PREMIUM") amount = 15 * 83;

        await Prisma.invoice.create({
            data: {
                invoiceId: generateInvoiceId(),
                subscriptionId: sub.id,
                amount,
                status: "PENDING",
            },
        });

        const nextStartDate = new Date(sub.endDate);
        const nextEndDate = new Date(nextStartDate);
        if (sub.billingCycle === "MONTHLY")
            nextEndDate.setMonth(nextEndDate.getMonth() + 1);
        else if (sub.billingCycle === "YEARLY")
            nextEndDate.setFullYear(nextEndDate.getFullYear() + 1);

        await Prisma.subscription.update({
            where: { id: sub.id },
            data: {
                startDate: nextStartDate,
                endDate: nextEndDate,
            },
        });

        console.log(`📄 Invoice generated & subscription renewed for user: ${sub.userId}`);
    }
});
