// services/s3Service.js
import AWS from "aws-sdk";
import { v4 as uuidv4 } from "uuid";

console.log("AWS S3 Service Initialized");

console.log(
  "accessKeyId:", process.env.AWS_ACCESS_KEY_ID,
  "secretAccessKey:", process.env.AWS_SECRET_ACCESS_KEY,
  "region:", process.env.AWS_REGION,
);

// Configure AWS SDK
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

console.log("s3", s3);


/**
 * Upload a file to S3
 * @param {string} bucket - The target S3 bucket
 * @param {string} key - The file path inside the bucket
 * @param {Buffer|String} body - File content
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} - S3 object URL
 */
export async function uploadToS3({ bucket, key, body, contentType }) {
  console.log("bucket",bucket, "key",key, "body",body, "contentType",contentType);
  
  if (!bucket || !key || !body) {
    throw new Error("❌ Missing required parameters for S3 upload");
  }

  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
  };

  console.log("Uploading to S3:", params);
  

  try {
    await s3.putObject(params).promise();
    console.log(`✅ Uploaded to S3: ${bucket}/${key}`);
    return `https://${bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  } catch (error) {
    console.error("❌ S3 Upload Error:", error);
    throw error;
  }
}

/**
 * Generate a unique S3 key
 */
export function generateS3Key(prefix, filename) {
  const cleanFilename = filename.replace(/\s+/g, "_");
  return `${prefix}/${Date.now()}-${uuidv4()}-${cleanFilename}`;
}

/**
 * Ensure bucket exists
 */
export async function ensureBucketExists(bucketName) {
  try {
    await s3.headBucket({ Bucket: bucketName }).promise();
    console.log(`ℹ️ Bucket already exists: ${bucketName}`);
  } catch (err) {
    if (err.statusCode === 404) {
      await s3.createBucket({ Bucket: bucketName }).promise();
      console.log(`✅ Created new bucket: ${bucketName}`);
    } else {
      throw err;
    }
  }
}
