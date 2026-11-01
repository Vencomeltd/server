// Private file storage for the admin Documents drive and data exports
// (build spec section 9), on Cloudflare R2. Files are never linked publicly:
// downloads go through short-lived signed URLs. Uses R2_DOCUMENTS_BUCKET if
// set (recommended: a private bucket), otherwise the main bucket under
// unguessable keys.
const { randomUUID } = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
});

const bucket = () => process.env.R2_DOCUMENTS_BUCKET || process.env.R2_BUCKET_NAME;

const newKey = (fileName) => `admin-documents/${randomUUID()}/${String(fileName).replace(/[^\w.\- ]+/g, "_")}`;

async function putFile(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: contentType || "application/octet-stream" }));
}

// A link that downloads the file under its display name, valid for 5 minutes.
function downloadUrl(key, fileName) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ResponseContentDisposition: `attachment; filename="${String(fileName).replace(/["\\\r\n]/g, "")}"`,
    }),
    { expiresIn: 300 }
  );
}

async function fileStream(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return res.Body;
}

async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

module.exports = { newKey, putFile, downloadUrl, fileStream, deleteFile };
