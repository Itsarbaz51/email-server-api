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
  const userId = req.user.id;

  if (!name || !userId) {
    throw new ApiError(400, "Domain name and user ID required");
  }

  // Check if domain already exists
  const exists = await Prisma.domain.findUnique({
    where: { name },
  });

  if (exists) {
    throw new ApiError(409, "Domain already exists");
  }

  // Create domain in SendGrid
  const sendgridData = await getSendGridDNSRecords(name);
  if (!sendgridData?.id || !sendgridData?.dns) {
    throw new ApiError(500, "Failed to get DNS records from SendGrid");
  }

  // Save domain in DB
  const createdDomain = await Prisma.domain.create({
    data: {
      name,
      userId,
      sendgridDomainId: sendgridData.id.toString(),
      status: "PENDING",
      dkimEnabled: false,
      dkimTokens: JSON.stringify([]),
    },
  });

  // Convert SendGrid DNS records into our schema format
  const sendgridDNS = Object.entries(sendgridData.dns).map(([_, value]) => ({
    recordType: value?.type.toUpperCase() || "CNAME",
    recordName: value?.host || "",
    recordValue: value?.data || "",
    ttl: value?.ttl || 3600,
    domainId: createdDomain.id,
  }));

  // Add custom MX record for platform
  const mxRecord = {
    recordType: "MX",
    recordName: name,
    recordValue: "mail.primewebdev.in",
    ttl: 3600,
    domainId: createdDomain.id,
  };

  const allRecords = [mxRecord, ...sendgridDNS];

  // Save DNS records
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

  console.log(`Found domain: ${domain}`);

  if (!domain) throw new ApiError(404, "Domain not found");

  let allValid = true;

  // Step 1: Local DNS check for all records
  for (const record of domain.dnsRecords) {
    const isValid = await verifyDnsRecord(record);
    console.log(`Record ${record.recordName} (${record.recordType}): verified=${isValid}`);
    if (!isValid) allValid = false;

    await Prisma.dNSRecord.update({
      where: { id: record.id },
      data: { isVerified: isValid },
    });
  }

  // Step 2: SendGrid validation
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

  // Step 3: Update domain status based on verification
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

// DNS record check
async function verifyDnsRecord(record) {
  try {
    if (record.recordType === "MX") {
      const mxRecords = await dns.resolveMx(record.recordName);
      console.log(mxRecords);
      
      return mxRecords.some((mx) => mx.exchange === record.recordValue);
    }

    const result = await dns.resolve(record.recordName, record.recordType);

    if (record.recordType === "TXT") {
      const flattened = result
        .flat()
        .map((r) => (Array.isArray(r) ? r.join("") : r));
      return flattened.includes(record.recordValue);
    }

    return result.includes(record.recordValue);
  } catch (error) {
    console.error(`Error verifying DNS record: ${error.message}`);
    return false;
  }
}

// SendGrid API call
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
    throw new ApiError(500, "Failed to fetch SendGrid DNS records");
  }
}
