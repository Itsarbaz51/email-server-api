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

// Auto verify domains cron job
export async function autoVerifyDomains() {
  console.log("🔄 Running auto domain verification job...");

  const domains = await Prisma.domain.findMany({
    where: { isVerified: false },
    include: { dnsRecords: true },
  });

  for (const domain of domains) {
    try {
      let allValid = true;

      for (const record of domain.dnsRecords) {
        const isValid = await verifyDnsRecord(record, domain.name);

        await Prisma.dNSRecord.update({
          where: { id: record.id },
          data: { isVerified: isValid },
        });

        if (!isValid) allValid = false;
      }

      await Prisma.domain.update({
        where: { id: domain.id },
        data: {
          isVerified: allValid,
          status: allValid ? "VERIFIED" : "PENDING",
        },
      });
    } catch (err) {
      console.error(`❌ Error verifying domain ${domain.name}:`, err.message);
    }
  }
}

// get all domains for a user
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
  const name = req.params.domainName;
  const userId = req.user.id;

  if (!name) return ApiError.send(res, 401, "Domain name is required");
  if (!userId) return ApiError.send(res, 401, "Unauthorized User");

  const domain = await Prisma.domain.findFirst({
    where: { name, userId },
  });

  if (!domain) return ApiError.send(res, 404, "Domain not found");

  try {
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
  }

  await Prisma.dNSRecord.deleteMany({
    where: { domainId: domain.id },
  });

  await Prisma.domain.delete({
    where: { id: domain.id },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "Domain deleted successfully"));
});

// DNS record verification helper
async function verifyDnsRecord(record, domainName) {
  try {
    const verifyBySendGrid = validateDomain(record.domainId);
    if (verifyBySendGrid) return true;

    if (record.recordType === "MX") {
      const mxRecords = await dns.resolveMx(domainName);

      return mxRecords.some(
        (mx) => mx.exchange.toLowerCase() === record.recordValue.toLowerCase()
      );
    }

    const lookupName =
      record.recordName === "@" ? domainName : record.recordName;
    const result = await dns.resolve(lookupName, record.recordType);

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

export const allDomains = asyncHandler(async (req, res) => {
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

  const domains = await Prisma.domain.findMany({
    orderBy: { createdAt: "desc" },
    include: { mailboxes: true },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, "All domains fetched successfully", domains));
});
