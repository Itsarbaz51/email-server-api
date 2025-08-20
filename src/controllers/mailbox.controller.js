import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { comparePassword, hashPassword } from "../utils/lib.js";

// Create Mailbox
const createMailbox = asyncHandler(async (req, res) => {
  const { name, email, domainId, password } = req.body;
  const userId = req.user.id;

  if (!name || !email || !domainId || !password) {
    return ApiError.send(
      res,
      400,
      "Name, email, domainId, and password are required"
    );
  }

  // Hash password before storing (assuming you have a hashPassword function)
  const hashedPassword = await hashPassword(password);

  // Fetch domain and include DNS records verification status
  const domain = await Prisma.domain.findUnique({
    where: { id: domainId },
    include: {
      dnsRecords: true,
    },
  });

  console.log(domain, domain.userId, userId);

  if (!domain || domain.userId !== userId) {
    return ApiError.send(res, 403, "Unauthorized domain access");
  }

  if (domain.status !== "VERIFIED") {
    return ApiError.send(
      res,
      400,
      "Domain must be verified before creating mailboxes"
    );
  }

  const fullEmail = email.includes("@")
    ? email.toLowerCase()
    : `${email.toLowerCase()}@${domain.name}`;

  const [localPart] = fullEmail.split("@");

  if (!/^[a-zA-Z0-9._%+-]+$/.test(localPart)) {
    return ApiError.send(res, 400, "Invalid mailbox email format");
  }

  const existingMailbox = await Prisma.mailbox.findFirst({
    where: { emailAddress: fullEmail },
  });

  if (existingMailbox) {
    return ApiError.send(res, 400, `Mailbox "${fullEmail}" already exists.`);
  }

  const mailbox = await Prisma.mailbox.create({
    data: {
      name,
      emailAddress: fullEmail,
      userId,
      domainId,
      password: hashedPassword,
      status: "ACTIVE",
      isActive: true,
      usedStorageMB: 0,
    },
    include: {
      domain: {
        select: { name: true },
      },
    },
  });

  return res.status(201).json(
    new ApiResponse(201, "Mailbox created successfully", {
      mailbox: {
        id: mailbox.id,
        name: mailbox.name,
        emailAddress: mailbox.emailAddress,
        domain: mailbox.domain.name,
      },
    })
  );
});

// Get all mailboxes for the authenticated admin's domains
const getMailboxes = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const mailboxes = await Prisma.mailbox.findMany({
    where: {
      domain: {
        userId: userId,
        status: "VERIFIED",
      },
    },
    include: {
      domain: {
        select: {
          name: true,
          status: true,
        },
      },
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Mailboxes fetched successfully", mailboxes));
});

// Update mailbox status, name, or password
const updateMailbox = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, status, isActive, password } = req.body;
  const userId = req.user.id;

  // Ensure at least one field is provided
  if (
    ![name, email, status, isActive, password].some(
      (field) => field !== undefined && field !== null && field !== ""
    )
  ) {
    return ApiError.send(res, 400, "At least one field is required");
  }

  const mailbox = await Prisma.mailbox.findUnique({
    where: { id },
    include: { domain: true },
  });

  if (!mailbox || mailbox.domain.adminId !== userId) {
    return ApiError.send(res, 403, "Unauthorized to update mailbox.");
  }

  let hashedPassword;
  if (password) {
    hashedPassword = await hashPassword(password);
  }

  const dataToUpdate = {};

  if (name) dataToUpdate.name = name;
  if (email) dataToUpdate.email = email;

  if (status) {
    if (["ACTIVE", "SUSPENDED"].includes(status)) {
      dataToUpdate.status = status;
    } else {
      return ApiError.send(res, 400, "Invalid status value");
    }
  }

  if (typeof isActive !== "undefined") {
    dataToUpdate.isActive = Boolean(isActive);
  }

  if (password) dataToUpdate.password = hashedPassword;

  const updated = await Prisma.mailbox.update({
    where: { id },
    data: dataToUpdate,
    include: { domain: { select: { name: true } } },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Mailbox updated successfully", updated));
});

// Delete mailbox
const deleteMailbox = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const mailbox = await Prisma.mailbox.findUnique({
    where: { id },
    include: { domain: true },
  });

  if (!mailbox || mailbox.domain.userId !== userId) {
    return ApiError.send(res, 403, "Unauthorized to delete mailbox.");
  }

  // Delete mailbox (relations cascade in schema)
  await Prisma.mailbox.delete({ where: { id } });

  return res
    .status(200)
    .json(new ApiResponse(200, "Mailbox deleted successfully"));
});

async function activatePendingMailboxes() {
  // Find all mailboxes which are still pending
  const pendingMailboxes = await Prisma.mailbox.findMany({
    where: { status: "PENDING" },
    include: {
      domain: {
        include: {
          dnsRecords: true,
        },
      },
    },
  });

  for (const mailbox of pendingMailboxes) {
    const domain = mailbox.domain;

    // Check if domain and all DNS records are verified
    const allDnsVerified =
      domain.dnsRecords.length > 0 &&
      domain.dnsRecords.every((record) => record.isVerified === true);

    if (domain.verified && allDnsVerified) {
      // Update mailbox status to ACTIVE
      await Prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { status: "ACTIVE" },
      });
      console.log(`Mailbox ${mailbox.emailAddress} activated automatically.`);
    }
  }
}

setInterval(
  () => {
    activatePendingMailboxes().catch(console.error);
  },
  5 * 60 * 1000
);

export { createMailbox, getMailboxes, updateMailbox, deleteMailbox };
