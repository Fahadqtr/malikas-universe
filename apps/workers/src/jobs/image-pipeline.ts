/**
 * Image pipeline worker job.
 * Triggered after raw image bytes arrive in R2 staging (orphans/ prefix).
 *
 * Steps:
 *   1. Download from R2 staging
 *   2. Sharp: resize to 1200x1200 (white-pad), strip metadata
 *   3. Sharp: compress to JPG ≤200KB + WebP variant
 *   4. Compute pHash
 *   5. Upload final to products/{master_sku}/{filename}
 *   6. Insert product_images row + update products.image_url if primary
 */
import sharp from 'sharp';
import crypto from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../lib/logger.js';

// Lazy clients — only initialized when a job actually runs.
// Prevents the worker process from crashing at import time when
// env vars aren't set (e.g., local dev without R2 credentials).
let _s3: S3Client | null = null;
let _supabase: SupabaseClient | null = null;

function getS3(): S3Client {
  if (_s3) return _s3;
  if (!process.env.R2_ENDPOINT) {
    throw new Error('R2_ENDPOINT not configured — image pipeline disabled');
  }
  _s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  });
  return _s3;
}

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase env not configured for image pipeline worker');
  }
  _supabase = createClient(url, key);
  return _supabase;
}

const getBucket = () => process.env.R2_BUCKET ?? 'malikas-universe';
const getCdn = () => process.env.NEXT_PUBLIC_CDN_URL ?? '';

export type ImagePipelineJob = {
  master_sku: string;
  staging_key: string;       // e.g. "orphans/abc123.jpg"
  filename: string;          // final filename (without folder)
  is_primary: boolean;
  uploaded_by?: string;
};

export async function processImageJob(job: ImagePipelineJob): Promise<void> {
  const log = logger.child({ job: 'image-pipeline', sku: job.master_sku });
  const s3 = getS3();
  const supabase = getSupabase();
  const BUCKET = getBucket();
  const CDN = getCdn();

  // 1. Download from staging
  const raw = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: job.staging_key }));
  const inputBuffer = Buffer.from(await raw.Body!.transformToByteArray());
  log.info({ size: inputBuffer.length }, 'Downloaded from staging');

  // 2. Sharp: resize to 1200x1200 (contain on white)
  const processed = await sharp(inputBuffer)
    .resize(1200, 1200, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: '#FFFFFF' })
    .jpeg({ quality: 85, progressive: true, mozjpeg: true })
    .toBuffer();

  const meta = await sharp(processed).metadata();

  // 3. Generate WebP variant
  const webp = await sharp(inputBuffer)
    .resize(1200, 1200, { fit: 'contain', background: '#FFFFFF' })
    .flatten({ background: '#FFFFFF' })
    .webp({ quality: 82 })
    .toBuffer();

  // 4. pHash (8x8 average-hash; cheap, deterministic)
  const phash = await computePHash(inputBuffer);

  // 5. Upload final
  const finalKey = `products/${job.master_sku.toLowerCase()}/${job.filename}`;
  const webpKey = finalKey.replace(/\.(jpe?g|png)$/i, '.webp');

  await Promise.all([
    s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: finalKey,
        Body: processed,
        ContentType: 'image/jpeg',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: webpKey,
        Body: webp,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    ),
  ]);

  const cdnUrl = `${CDN}/${finalKey}`;

  // 6. Check for pHash duplicates before inserting
  const { data: similar } = await supabase
    .from('product_images')
    .select('id, master_sku, phash')
    .neq('master_sku', job.master_sku)
    .not('phash', 'is', null);

  const duplicates = (similar ?? []).filter((img) => img.phash && hamming(img.phash, phash) <= 5);

  if (job.is_primary) {
    await supabase
      .from('product_images')
      .update({ is_primary: false })
      .eq('master_sku', job.master_sku);
  }

  const { error: insertErr } = await supabase.from('product_images').insert({
    master_sku: job.master_sku,
    r2_key: finalKey,
    cdn_url: cdnUrl,
    filename: job.filename,
    is_primary: job.is_primary,
    width: meta.width,
    height: meta.height,
    format: 'jpg',
    file_size_kb: Math.round(processed.length / 1024),
    phash,
    uploaded_by: job.uploaded_by ?? 'image-worker',
  });

  if (insertErr) {
    log.error({ err: insertErr }, 'DB insert failed');
    throw insertErr;
  }

  if (job.is_primary) {
    await supabase
      .from('products')
      .update({
        image_url: cdnUrl,
        image_filename: job.filename,
      })
      .eq('master_sku', job.master_sku);
  }

  // 7. Cleanup staging
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: job.staging_key }));

  // 8. Log duplicate warnings
  if (duplicates.length > 0) {
    log.warn({ duplicates: duplicates.map((d) => d.master_sku) }, 'Possible duplicate images detected');
    await supabase.from('validation_issues').insert({
      master_sku: job.master_sku,
      rule_id: 'V10b',
      severity: 'low',
      field_name: 'image_url',
      message: `Image looks similar to ${duplicates.map((d) => d.master_sku).join(', ')}`,
    });
  }

  log.info({ cdnUrl, phash }, 'Image processed');
}

/**
 * Average-hash pHash (16-hex chars).
 */
async function computePHash(buf: Buffer): Promise<string> {
  const { data } = await sharp(buf)
    .resize(8, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = Array.from(data);
  const avg = pixels.reduce((a, b) => a + b, 0) / pixels.length;
  let hash = '';
  for (let i = 0; i < 64; i += 4) {
    const nibble =
      (pixels[i]! > avg ? 8 : 0) |
      (pixels[i + 1]! > avg ? 4 : 0) |
      (pixels[i + 2]! > avg ? 2 : 0) |
      (pixels[i + 3]! > avg ? 1 : 0);
    hash += nibble.toString(16);
  }
  return hash;
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    d += [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][x]!;
  }
  return d;
}
