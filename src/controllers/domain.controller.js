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

  if (!name || !userId) {
    return ApiError.send(res, 400, "Domain name and user ID required");
  }

  // Check if domain already exists (case insensitive)
  const exists = await Prisma.domain.findFirst({
    where: {
      name: name.toLowerCase()
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
      dkimEnabled: false,
      dkimTokens: JSON.stringify([]),
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
// Verify Domain
export const verifyDomain = asyncHandler(async (req, res) => {
  const { domainId } = req.params;
  console.log(`Verifying domain with ID: ${domainId}`);

  const domain = await Prisma.domain.findFirst({
    where: { id: domainId },
    include: { dnsRecords: true },
  });

  if (!domain) return ApiError.send(res, 404, "Domain not found");

  let allValid = true;

  // Pass domain.name to verifyDnsRecord
  for (const record of domain.dnsRecords) {
    const isValid = await verifyDnsRecord(record, domain.name);
    console.log(`Record ${record.recordName} (${record.recordType}): verified=${isValid}`);
    if (!isValid) allValid = false;

    await Prisma.dNSRecord.update({
      where: { id: record.id },
      data: { isVerified: isValid },
    });
  }

  // SendGrid validation stays the same
  if (domain.sendgridDomainId) {
    const sendgridRes = await validateDomain(domain.sendgridDomainId);

    if (sendgridRes?.validation_results) {
      const { dkim1, dkim2, mail_cname } = sendgridRes.validation_results;
      const sendgridResults = [
        { key: "s1._domainkey", result: dkim1 },
        { key: "s2._domainkey", result: dkim2 },
        { key: "em", result: mail_cname },
      ];

      for (const record of domain.dnsRecords) {
        const matching = sendgridResults.find((sg) =>
          record.recordName.includes(sg.key)
        );
        if (matching) {
          await Prisma.dNSRecord.update({
            where: { id: record.id },
            data: { isVerified: matching.result.valid },
          });
          if (!matching.result.valid) allValid = false;
        }
      }
    }
  } else {
    console.warn(`No sendgridDomainId found for domain ${domain.id}`);
  }

  const domainStatus = allValid ? "VERIFIED" : "PENDING";
  await Prisma.domain.update({
    where: { id: domain.id },
    data: { status: domainStatus },
  });

  return res.status(200).json(
    new ApiResponse(200, "Domain DNS records verified", {
      domainVerified: allValid,
    })
  );
});

export const getDomains = asyncHandler(async (req, res) => {
  const userId = req.user?.id;

  if (!userId) {
    return ApiError.send(res, 401, "Unauthorized User");
  }

  const domains = await Prisma.domain.findMany({
    where: {
      userId,
    },
  });

  if (!domains || domains.length === 0) {
    return ApiError.send(res, 404, "Domain records not found");
  }

  return res.status(200).json(
    new ApiResponse(200, "Domains fetched", domains)
  );
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

      return mxRecords.some(mx => mx.exchange.toLowerCase() === record.recordValue.toLowerCase());
    }

    // TXT, CNAME, A, etc.
    const lookupName = record.recordName === "@" ? domainName : record.recordName;
    const result = await dns.resolve(lookupName, record.recordType);
    console.log(`DNS Records for ${lookupName}:`, result);

    if (record.recordType === "TXT") {
      const flattened = result.flat().map(r => (Array.isArray(r) ? r.join('') : r));
      return flattened.some(txt => txt.includes(record.recordValue));
    }

    return result.some(r => r.toLowerCase() === record.recordValue.toLowerCase());
  } catch (error) {
    console.error(`Error verifying DNS record for ${record.recordName}:`, error.message);
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
