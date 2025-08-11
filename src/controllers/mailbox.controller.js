import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";

// Create Mailbox
const createMailbox = asyncHandler(async (req, res) => {
  const { name, address, domainId } = req.body;
  const userId = req.user.id;

  if (!name || !address || !domainId) {
    return ApiError.send(res, 400, "Name, address, and domainId are required");
  }

  // Fetch domain and validate ownership
  const domain = await Prisma.domain.findUnique({
    where: { id: domainId },
  });

  if (!domain || domain.adminId !== userId) {
    return ApiError.send(res, 403, "Unauthorized domain access");
  }

  if (!domain.verified) {
    return ApiError.send(
      res,
      400,
      "Domain must be verified before creating mailboxes"
    );
  }

  // Normalize full email
  const fullEmail = address.includes("@")
    ? address.toLowerCase()
    : `${address.toLowerCase()}@${domain.name}`;

  const [localPart] = fullEmail.split("@");

  if (!/^[a-zA-Z0-9._%+-]+$/.test(localPart)) {
    return ApiError.send(res, 400, "Invalid mailbox address format");
  }

  // Check for existing mailbox
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
      status: "PENDING",
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
      domain: { adminId: userId },
    },
    include: {
      domain: { select: { name: true, verified: true } },
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Mailboxes fetched successfully", mailboxes));
});

// Update mailbox status or name
const updateMailbox = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, status, isActive } = req.body;
  const userId = req.user.id;

  const mailbox = await Prisma.mailbox.findUnique({
    where: { id },
    include: { domain: true },
  });

  if (!mailbox || mailbox.domain.adminId !== userId) {
    return ApiError.send(res, 403, "Unauthorized to update mailbox.");
  }

  const updated = await Prisma.mailbox.update({
    where: { id },
    data: { name, status, isActive },
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

  if (!mailbox || mailbox.domain.adminId !== userId) {
    return ApiError.send(res, 403, "Unauthorized to delete mailbox.");
  }

  // Delete mailbox (relations cascade in schema)
  await Prisma.mailbox.delete({ where: { id } });

  return res
    .status(200)
    .json(new ApiResponse(200, "Mailbox deleted successfully"));
});

export { createMailbox, getMailboxes, updateMailbox, deleteMailbox };
