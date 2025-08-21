import Prisma from "../src/db/db.js";
import { hashPassword } from "../src/utils/lib.js";

async function main() {
  const superAdminEmail = "azzunique.com@gmail.com";
  const superAdminPhone = "7412066471";
  const superAdminPassword = "Azz@181883";

  // Check if super admin already exists
  const exists = await Prisma.user.findFirst({
    where: {
      OR: [
        { email: superAdminEmail },
        { phone: superAdminPhone },
        { role: "SUPER_ADMIN" },
      ],
    },
  });

  let superAdmin;

  if (exists) {
    console.log("✅ Superadmin already exists:", exists.email);
    superAdmin = exists;
  } else {
    const hashed = await hashPassword(superAdminPassword);

    superAdmin = await Prisma.user.create({
      data: {
        name: "Super Admin",
        email: superAdminEmail,
        phone: superAdminPhone,
        password: hashed,
        role: "SUPER_ADMIN",
        termsAndConditions: true,
        isActive: true,
        isAuthorized: true,
      },
    });

    console.log("🎉 Superadmin created successfully:", superAdmin.email);
  }

  // Check if subscription already exists
  const existingSub = await Prisma.subscription.findFirst({
    where: { userId: superAdmin.id, plan: "FREE" },
  });

  if (!existingSub) {
    await Prisma.subscription.create({
      data: {
        plan: "FREE", // lifetime free
        billingCycle: "LIFETIME",
        maxMailboxes: 9999,
        maxDomains: 9999,
        maxSentEmails: 999999,
        maxReceivedEmails: 999999,
        allowedStorageMB: 999999,
        storageUsedMB: 0,
        paymentStatus: "FREE",
        paymentProvider: "FREE",
        startDate: new Date(),
        endDate: new Date("2099-12-31T23:59:59Z"), // practically lifetime
        isActive: true,
        userId: superAdmin.id,
      },
    });
    console.log("🎁 Lifetime free subscription created for:", superAdmin.email);
  } else {
    console.log(
      "⚡ Lifetime free subscription already exists for:",
      superAdmin.email
    );
  }
}

main()
  .then(async () => {
    await Prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await Prisma.$disconnect();
    process.exit(1);
  });
