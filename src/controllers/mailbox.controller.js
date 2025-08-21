import Prisma from "../db/db.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { hashPassword } from "../utils/lib.js";

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

//////////////////////////////////////////// suer admin /////////////////////////////////////////////////

export const allMailbox = asyncHandler(async (req, res) => {
  const superAdminId = req.user?.id;
  if (!superAdminId) {
    return ApiError.send(res, 401, "Unauthorized user");
  }

  if (req.user.role !== "SUPER_ADMIN") {
    return ApiError.send(
      res,
      403,
      "Forbidden: Only superadmin can access this"
    );
  }

  // -------- Query Params ----------
  const page = Math.max(parseInt(req.query.page?.toString() || "1", 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit?.toString() || "20", 10), 1),
    100
  );
  const skip = (page - 1) * limit;

  const search = (req.query.search || "").toString().trim();
  const role = (req.query.role || "").toString().trim() || undefined;

  const includeTrashed =
    (req.query.includeTrashed || "false").toString().toLowerCase() === "true";

  const sortWhitelist = [
    "createdAt",
    "updatedAt",
    "subject",
    "from",
    "to",
    "isRead",
  ];
  const sortBy = sortWhitelist.includes((req.query.sortBy || "").toString())
    ? req.query.sortBy.toString()
    : "createdAt";
  const sortOrder =
    (req.query.sortOrder || "desc").toString().toLowerCase() === "asc"
      ? "asc"
      : "desc";

  // Date filters
  const dateFrom = req.query.dateFrom
    ? new Date(req.query.dateFrom.toString())
    : undefined;
  const dateTo = req.query.dateTo
    ? new Date(req.query.dateTo.toString())
    : undefined;

  // -------- Build Prisma Where ----------
  /**
   * NOTE: Adjust fields in OR[] as per your mailbox schema.
   * Common fields considered: subject, from, to, name, email, message.
   */
  const where = {
    ...(role ? { role } : {}),
    ...(!includeTrashed ? { deletedAt: null } : {}),
    ...(search
      ? {
          OR: [
            { subject: { contains: search, mode: "insensitive" } },
            { from: { contains: search, mode: "insensitive" } },
            { to: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
            { email: { contains: search, mode: "insensitive" } },
            { message: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {}),
  };

  // -------- Query DB ----------
  const [total, admins] = await Promise.all([
    Prisma.mailbox.count({ where }),
    Prisma.mailbox.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
      // include / select ko yahan customize kar sakte ho:
      // select: { id: true, subject: true, from: true, ... }
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return res.status(200).json(
    new ApiResponse(200, "All mailbox fetched successfully", {
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        sortBy,
        sortOrder,
      },
      filters: {
        search: search || null,
        role: role || null,
        dateFrom: dateFrom ? dateFrom.toISOString() : null,
        dateTo: dateTo ? dateTo.toISOString() : null,
        includeTrashed,
      },
      data: admins,
    })
  );
});

export { createMailbox, getMailboxes, updateMailbox, deleteMailbox };
