/**
 * Cloudflare R2 client (S3-compatible).
 * Used for image uploads + signed URLs.
 */
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/lib/env';

let _client: S3Client | null = null;

function getR2Client(): S3Client {
  if (_client) return _client;

  if (
    !env.R2_ACCOUNT_ID ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_ENDPOINT
  ) {
    throw new Error(
      'R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT in Doppler to enable image uploads.',
    );
  }

  _client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  return _client;
}

/**
 * Upload buffer to R2.
 * @param key - R2 object key, e.g. "products/MK-SKIN-0001/primary.jpg"
 * @param body - File bytes
 * @param contentType - MIME type
 * @returns Public CDN URL
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  const cdn = env.NEXT_PUBLIC_CDN_URL ?? `${env.R2_ENDPOINT}/${env.R2_BUCKET}`;
  return `${cdn}/${key}`;
}

export async function deleteFromR2(key: string): Promise<void> {
  const client = getR2Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
    }),
  );
}

export async function r2ObjectExists(key: string): Promise<boolean> {
  const client = getR2Client();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: env.R2_BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a presigned upload URL for direct browser uploads.
 * Expires in 5 minutes by default.
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 300,
): Promise<string> {
  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Standard R2 key for a product image.
 * Always lowercase, slash-separated.
 */
export function productImageKey(masterSku: string, filename = 'primary.jpg'): string {
  return `products/${masterSku.toLowerCase()}/${filename.toLowerCase()}`;
}
