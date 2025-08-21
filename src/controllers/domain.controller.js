import dns from "dns/promises";
import axios from "axios";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import Prisma from "../db/db.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateDomain } from "../services/sendgridService.js";

// Add Domain
export const addDomain = asyncHandler(async (req, res) => {
  const { name } = req.body;
  const userId = req.user?.id;
  // const s

  if (!name || !userId) {
    return ApiError.send(res, 400, "Domain name and user ID required");
  }

  // Check if domain already exists (case insensitive)
  const exists = await Prisma.domain.findFirst({
    where: {
      name: name.toLowerCase(),
    },
  });

  if (exists) {
    return ApiError.send(res, 409, "Domain already exists");
  }

  // Create domain in SendGrid (make sure domain is lower case)
  const sendgridData = await getSendGridDNSRecords(name.toLowerCase());
  if (!sendgridData?.id || !sendgridData?.dns) {
    return ApiError.send(res, 500, "Failed to get DNS records from SendGrid");
  }

  // Save domain in DB
  const createdDomain = await Prisma.domain.create({
    data: {
      name: name.toLowerCase(),
      userId,
      sendgridDomainId: sendgridData.id.toString(),
      status: "PENDING",
      isVerified: false,
    },
  });

  // Convert SendGrid DNS records into our schema format
  const sendgridDNS = Object.entries(sendgridData.dns).map(([_, value]) => ({
    recordType: value?.type?.toUpperCase() || "CNAME",
    recordName: value?.host || "",
    recordValue: value?.data || "",
    ttl: value?.ttl || 3600,
    domainId: createdDomain.id,
  }));

  // Add custom MX record for platform (use lower case recordName)
  const mxRecord = {
    recordType: "MX",
    recordName: "@",
    recordValue: "mail.primewebdev.in",
    ttl: 3600,
    domainId: createdDomain.id,
  };

  const allRecords = [mxRecord, ...sendgridDNS];

  // Save DNS records in bulk
  await Prisma.dNSRecord.createMany({
    data: allRecords,
  });

  return res.status(201).json(
    new ApiResponse(201, "Domain added and DNS records saved", {
      domain: createdDomain,
      dnsRecords: allRecords,
    })
  );
});

// Verify Domain with Enhanced Validation
export const verifyDomain = asyncHandler(async (req, res) => {
  console.log(req.params);

  const { name } = req.params;
  console.log(`Verifying domain with ID: ${name}`);

  const domain = await Prisma.domain.findFirst({
    where: { name },
    include: { dnsRecords: true },
  });

  if (!domain) return ApiError.send(res, 404, "Domain not found");

  // Check if domain was verified in the last 24 hours and failed
  const lastVerificationTime = domain.lastVerificationAttempt;
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  if (
    lastVerificationTime &&
    lastVerificationTime > twentyFourHoursAgo &&
    !domain.isVerified
  ) {
    const nextAttemptTime = new Date(
      lastVerificationTime.getTime() + 24 * 60 * 60 * 1000
    );
    const timeRemaining = Math.ceil(
      (nextAttemptTime - new Date()) / (1000 * 60 * 60)
    );

    return ApiError.send(
      res,
      429,
      `Please wait ${timeRemaining} hours before attempting verification again. DNS changes may take up to 24 hours to propagate.`
    );
  }

  let allValid = true;
  let validationResults = [];

  // Verify DNS records
  for (const record of domain.dnsRecords) {
    const isValid = await verifyDnsRecord(record, domain.name);
    console.log(
      `Record ${record.recordName} (${record.recordType}): verified=${isValid}`
    );

    validationResults.push({
      recordName: record.recordName,
      recordType: record.recordType,
      isValid: isValid,
    });

    if (!isValid) allValid = false;

    await Prisma.dNSRecord.update({
      where: { id: record.id },
      data: { isVerified: isValid },
    });
  }

  // SendGrid validation
  let sendgridValidation = { isValid: true, details: [] };
  if (domain.sendgridDomainId) {
    const sendgridRes = await validateDomain(domain.sendgridDomainId);

    if (sendgridRes?.validation_results) {
      const { dkim1, dkim2, mail_cname } = sendgridRes.validation_results;
      const sendgridResults = [
        { key: "s1._domainkey", result: dkim1, name: "DKIM 1" },
        { key: "s2._domainkey", result: dkim2, name: "DKIM 2" },
        { key: "em", result: mail_cname, name: "Mail CNAME" },
      ];

      for (const record of domain.dnsRecords) {
        const matching = sendgridResults.find((sg) =>
          record.recordName.includes(sg.key)
        );
        if (matching) {
          const isValid = matching.result.valid;
          sendgridValidation.details.push({
            record: matching.name,
            isValid: isValid,
            message: isValid ? "Valid" : matching.result.reason || "Invalid",
          });

          if (!isValid) {
            sendgridValidation.isValid = false;
            allValid = false;
          }

          await Prisma.dNSRecord.update({
            where: { id: record.id },
            data: { isVerified: isValid },
          });
        }
      }
    }
  } else {
    console.warn(`No sendgridDomainId found for domain ${domain.id}`);
    sendgridValidation.details.push({
      record: "SendGrid",
      isValid: false,
      message: "SendGrid domain not configured",
    });
    allValid = false;
  }

  // Update domain verification status and timestamp
  const domainStatus = allValid ? "VERIFIED" : "PENDING";
  const domainVerified = allValid;

  await Prisma.domain.update({
    where: { id: domain.id },
    data: {
      status: domainStatus,
      isVerified: domainVerified,
      // lastVerificationAttempt: new Date()
    },
  });

  // Prepare response
  if (allValid) {
    return res.status(200).json(
      new ApiResponse(200, "Domain successfully verified!", {
        domainVerified: true,
        validationResults: validationResults,
        sendgridValidation: sendgridValidation,
      })
    );
  } else {
    return res.status(400).json(
      new ApiResponse(
        400,
        "Domain verification failed. Please check your DNS records and try again after 24 hours.",
        {
          domainVerified: false,
          validationResults: validationResults,
          sendgridValidation: sendgridValidation,
          nextAttemptAllowed: new Date(
            Date.now() + 24 * 60 * 60 * 1000
          ).toISOString(),
          message:
            "DNS changes may take up to 24 hours to propagate. Please wait before trying again.",
        }
      )
    );
  }
});

export const getDomains = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return ApiError.send(res, 401, "Unauthorized User");
  }

  const domains = await Prisma.domain.findMany({
    where: {
      userId: userId,
    },
    include: {
      dnsRecords: true,
    },
  });

  if (!domains || domains.length === 0) {
    return ApiError.send(res, 404, "Domain records not found");
  }

  return res.status(200).json(new ApiResponse(200, "Domains fetched", domains));
});

// delete domain
export const deleteDomain = asyncHandler(async (req, res) => {
  console.log(req.params);

  const name = req.params.domainName;
  const userId = req.user.id;

  if (!name) return ApiError.send(res, 401, "Domain name is required");
  if (!userId) return ApiError.send(res, 401, "Unauthorized User");

  const domain = await Prisma.domain.findFirst({
    where: { name, userId },
  });

  if (!domain) return ApiError.send(res, 404, "Domain not found");

  try {
    // 1️⃣ Delete domain from SendGrid
    if (domain.sendgridId) {
      await axios.delete(
        `https://api.sendgrid.com/v3/whitelabel/domains/${domain.sendgridId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          },
        }
      );
    } else {
      // fallback: find domain by name if id not stored
      const resp = await axios.get(
        `https://api.sendgrid.com/v3/whitelabel/domains`,
        {
          headers: {
            Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          },
        }
      );

      const sgDomain = resp.data.find((d) => d.domain === name);
      if (sgDomain) {
        await axios.delete(
          `https://api.sendgrid.com/v3/whitelabel/domains/${sgDomain.id}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
            },
          }
        );
      }
    }
  } catch (err) {
    console.error("SendGrid domain delete failed:", err.response?.data || err);
    // Not blocking local deletion — you may choose to return error instead
  }

  // 2️⃣ Delete DNS records from DB
  await Prisma.dNSRecord.deleteMany({
    where: { domainId: domain.id },
  });

  // 3️⃣ Delete domain from DB
  await Prisma.domain.delete({
    where: { id: domain.id },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Domain deleted successfully"));
});

// DNS record verification helper (fixed)
async function verifyDnsRecord(record, domainName) {
  try {
    if (record.recordType === "MX") {
      console.log(record);
      console.log(`Verifying MX record for ${record.recordName}...`);

      // MX records hamesha domain ke liye resolve karenge
      const mxRecords = await dns.resolveMx(domainName);
      console.log(`MX Records for ${domainName}:`, mxRecords);

      return mxRecords.some(
        (mx) => mx.exchange.toLowerCase() === record.recordValue.toLowerCase()
      );
    }

    // TXT, CNAME, A, etc.
    const lookupName =
      record.recordName === "@" ? domainName : record.recordName;
    const result = await dns.resolve(lookupName, record.recordType);
    console.log(`DNS Records for ${lookupName}:`, result);

    if (record.recordType === "TXT") {
      const flattened = result
        .flat()
        .map((r) => (Array.isArray(r) ? r.join("") : r));
      return flattened.some((txt) => txt.includes(record.recordValue));
    }

    return result.some(
      (r) => r.toLowerCase() === record.recordValue.toLowerCase()
    );
  } catch (error) {
    console.error(
      `Error verifying DNS record for ${record.recordName}:`,
      error.message
    );
    return false;
  }
}

// SendGrid API call to create domain & get DNS records
async function getSendGridDNSRecords(domain) {
  try {
    const response = await axios.post(
      "https://api.sendgrid.com/v3/whitelabel/domains",
      {
        domain,
        automatic_security: true,
        custom_spf: true,
        default: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (err) {
    console.error("SendGrid DNS fetch failed", err.response?.data || err);
    return ApiError.send(res, 500, "Failed to fetch SendGrid DNS records");
  }
}

////////////////////////// super admin ///////////////////////////////////
/**
 * GET /domains
 * Query params (optional):
 *  - page: number (default 1)
 *  - limit: number (default 20, max 100)
 *  - search: string (matches fqdn/name/registrar/ownerEmail)
 *  - status: string (e.g. ACTIVE | EXPIRED | PENDING | SUSPENDED)  // adjust to your enum
 *  - isActive: "true" | "false"
 *  - sortBy: one of ["createdAt","updatedAt","fqdn","name","expiresAt","provider","status","isActive"]
 *  - sortOrder: "asc" | "desc" (default "desc")
 *  - dateFrom, dateTo: ISO (filters createdAt)
 *  - expiryFrom, expiryTo: ISO (filters expiresAt)
 *  - includeTrashed: "true" | "false" (default false; when false => deletedAt IS NULL)
 */
export const allDomains = asyncHandler(async (req, res) => {
  // ---- Auth ----
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

  // ---- Query Params ----
  const page = Math.max(parseInt(req.query.page?.toString() || "1", 10), 1);
  const limit = Math.min(
    Math.max(parseInt(req.query.limit?.toString() || "20", 10), 1),
    100
  );
  const skip = (page - 1) * limit;

  const search = (req.query.search || "").toString().trim();

  const includeTrashed =
    (req.query.includeTrashed || "false").toString().toLowerCase() === "true";

  const statusParam = (req.query.status || "").toString().trim() || undefined;

  const isActiveParam = (req.query.isActive || "").toString().toLowerCase();
  const isActiveFilter =
    isActiveParam === "true"
      ? true
      : isActiveParam === "false"
        ? false
        : undefined;

  const sortWhitelist = [
    "createdAt",
    "updatedAt",
    "fqdn",
    "name",
    "expiresAt",
    "provider",
    "status",
    "isActive",
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

  // Expiry filters
  const expiryFrom = req.query.expiryFrom
    ? new Date(req.query.expiryFrom.toString())
    : undefined;
  const expiryTo = req.query.expiryTo
    ? new Date(req.query.expiryTo.toString())
    : undefined;

  // ---- Build Prisma Where ----
  /**
   * NOTE: Fields used: fqdn, name, registrar, ownerEmail, provider, status, isActive, expiresAt, createdAt, deletedAt
   * Adjust to your actual Prisma schema if names differ.
   */
  const where = {
    ...(!includeTrashed ? { deletedAt: null } : {}),
    ...(statusParam ? { status: statusParam } : {}),
    ...(typeof isActiveFilter === "boolean"
      ? { isActive: isActiveFilter }
      : {}),
    ...(search
      ? {
          OR: [
            { fqdn: { contains: search, mode: "insensitive" } },
            { name: { contains: search, mode: "insensitive" } },
            { registrar: { contains: search, mode: "insensitive" } },
            { ownerEmail: { contains: search, mode: "insensitive" } },
            { provider: { contains: search, mode: "insensitive" } },
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
    ...(expiryFrom || expiryTo
      ? {
          expiresAt: {
            ...(expiryFrom ? { gte: expiryFrom } : {}),
            ...(expiryTo ? { lte: expiryTo } : {}),
          },
        }
      : {}),
  };

  // ---- Query DB ----
  const [total, domains] = await Promise.all([
    Prisma.domain.count({ where }),
    Prisma.domain.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip,
      take: limit,
      // Select ko apne schema ke hisaab se tune karein
      select: {
        id: true,
        fqdn: true, // e.g. "example.com"
        name: true, // friendly label / project name
        provider: true, // e.g. Cloudflare, GoDaddy
        registrar: true, // e.g. Namecheap
        ownerEmail: true,
        status: true, // enum/string
        isActive: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return res.status(200).json(
    new ApiResponse(200, "All domains fetched successfully", {
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
        status: statusParam || null,
        isActive: typeof isActiveFilter === "boolean" ? isActiveFilter : null,
        dateFrom: dateFrom ? dateFrom.toISOString() : null,
        dateTo: dateTo ? dateTo.toISOString() : null,
        expiryFrom: expiryFrom ? expiryFrom.toISOString() : null,
        expiryTo: expiryTo ? expiryTo.toISOString() : null,
        includeTrashed,
      },
      data: domains,
    })
  );
});
