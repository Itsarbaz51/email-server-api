import Prisma from "../src/db/db.js";
import { hashPassword } from "../src/utils/lib.js";

async function main() {
  const superAdminEmail = "azzunique.com@gmail.com";
  const superAdminPhone = " 7412066471";
  const superAdminPassword = "Azz@181883";

  const exists = await Prisma.user.findFirst({
    where: {
      OR: [
        { email: superAdminEmail },
        { phone: superAdminPhone },
        { role: "SUPER_ADMIN" },
      ],
    },
  });

  if (exists) {
    console.log("✅ Superadmin already exists:", exists.email);
    return;
  }

  const hashed = await hashPassword(superAdminPassword);

  const superAdmin = await Prisma.user.create({
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

main()
  .then(async () => {
    await Prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await Prisma.$disconnect();
    process.exit(1);
  });
