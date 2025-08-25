
import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";
import { ApiError } from "../utils/ApiError.js";

console.log("AWS S3 Service Initialized");

// S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Upload to S3
export async function uploadToS3({ bucket, key, body, contentType }) {
  if (!bucket || !key || !body) {
    throw ApiError.badRequest("Missing required parameters for S3 upload");
  }

  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
  };

  try {
    await s3.send(new PutObjectCommand(params));
    // console.log(`Uploaded to S3: ${bucket}/${key}`);
    return key; 
  } catch (error) {
    console.error("S3 Upload Error:", error);
    throw error;
  }
}

// Generate Presigned URL
export async function getPresignedUrl(bucket, key, expiresIn = 300) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return await getSignedUrl(s3, command, { expiresIn });
}

// Generate S3 key
export function generateS3Key(prefix, filename) {
  const cleanFilename = filename.replace(/\s+/g, "_");
  return `${prefix}/${Date.now()}-${uuidv4()}-${cleanFilename}`;
}

// Ensure bucket exists
export async function ensureBucketExists(bucketName) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    // console.log(`Bucket already exists: ${bucketName}`);
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404) {
      await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
      // console.log(`Created new bucket: ${bucketName}`);
    } else {
      throw err;
    }
  }
}
