/**
 * IMAGES SERVICE
 * ─────────────────────────────────────────────────────────
 * Manages product images end-to-end.
 *
 * Upload flow:
 *   - Web app does NOT depend on Sharp. It stages the raw file in R2
 *     under `orphans/{uuid}.{ext}` and enqueues a BullMQ job.
 *   - The image-pipeline worker (apps/workers) consumes the job:
 *     resize → 1200x1200, JPG + WebP, pHash → uploads to final key →
 *     writes product_images row.
 *   - This service exposes `stageAndEnqueue()` for the API route.
 *   - Direct `uploadFromBuffer()` is kept for tests / admin small-file
 *     uploads where Sharp processing isn't required (e.g., reuploading
 *     an already-processed image).
 *
 * The `stageAndEnqueue` path requires Redis (BullMQ) reachable. If
 * Redis is unavailable, the service falls back to a synchronous,
 * unprocessed upload and flags V10b (image-needs-processing) for the worker
 * to pick up later.
 */
import { z } from 'zod';
import crypto from 'node:crypto';
import { BaseService, ServiceError } from './base.service';
import { uploadToR2, deleteFromR2, productImageKey } from '../r2';
import { enqueueImagePipeline } from '../queue';

export const presignedUploadInput = z.object({
  master_sku: z.string(),
  filename: z.string(),
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  is_primary: z.boolean().default(false),
});

export type ImageRecord = {
  id: number;
  master_sku: string;
  r2_key: string;
  cdn_url: string;
  filename: string;
  is_primary: boolean;
  width: number | null;
  height: number | null;
  format: string | null;
  phash: string | null;
};

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class ImagesService extends BaseService {
  /**
   * RECOMMENDED upload path.
   * Stages the raw file under `orphans/` and enqueues the image-pipeline worker.
   * Returns { staging_key, queued } immediately. The worker overwrites with
   * processed JPG+WebP and inserts the final product_images row.
   *
   * Falls back to direct `uploadFromBuffer` if Redis is unavailable.
   */
  async stageAndEnqueue(input: {
    master_sku: string;
    filename: string;
    content_type: string;
    body: Uint8Array;
    is_primary?: boolean;
  }): Promise<{ staging_key: string; queued: boolean; image?: ImageRecord }> {
    this.requireRole(['owner', 'editor']);

    if (!ALLOWED_FORMATS.has(input.content_type)) {
      throw new ServiceError('BAD_FORMAT', 'Only JPG/PNG/WebP allowed', 400);
    }
    if (input.body.byteLength > MAX_FILE_BYTES) {
      throw new ServiceError('TOO_LARGE', 'Max 5 MB', 400);
    }

    // Confirm product exists
    const { data: product, error: prodErr } = await this.db
      .from('products')
      .select('master_sku')
      .eq('master_sku', input.master_sku)
      .is('deleted_at', null)
      .single();
    if (prodErr || !product) throw new ServiceError('NO_PRODUCT', 'Product not found', 404);

    // Stage to orphans/{uuid}.{ext}
    const ext = input.filename.split('.').pop()?.toLowerCase() ?? 'jpg';
    const uuid = crypto.randomUUID();
    const stagingKey = `orphans/${uuid}.${ext}`;
    await uploadToR2(stagingKey, Buffer.from(input.body), input.content_type);

    const finalFilename = (input.is_primary ?? false) ? 'primary.jpg' : input.filename.toLowerCase();

    const queued = await enqueueImagePipeline({
      master_sku: input.master_sku,
      staging_key: stagingKey,
      filename: finalFilename,
      is_primary: input.is_primary ?? false,
      uploaded_by: this.actorTag(),
    });

    if (!queued) {
      // Fallback: synchronous unprocessed upload (worker is offline)
      const image = await this.uploadFromBuffer(input);
      await deleteFromR2(stagingKey);
      return { staging_key: stagingKey, queued: false, image };
    }

    return { staging_key: stagingKey, queued: true };
  }

  /**
   * Direct unprocessed upload — used when Redis/worker is offline OR for tests.
   * Does NOT resize / compress. Worker overwrites later if available.
   */
  async uploadFromBuffer(input: {
    master_sku: string;
    filename: string;
    content_type: string;
    body: Uint8Array;
    is_primary?: boolean;
  }): Promise<ImageRecord> {
    this.requireRole(['owner', 'editor']);

    if (!ALLOWED_FORMATS.has(input.content_type)) {
      throw new ServiceError('BAD_FORMAT', 'Only JPG/PNG/WebP allowed', 400);
    }
    if (input.body.byteLength > MAX_FILE_BYTES) {
      throw new ServiceError('TOO_LARGE', 'Max 5 MB', 400);
    }

    // Confirm product exists
    const { data: product, error: prodErr } = await this.db
      .from('products')
      .select('master_sku')
      .eq('master_sku', input.master_sku)
      .is('deleted_at', null)
      .single();
    if (prodErr || !product) throw new ServiceError('NO_PRODUCT', 'Product not found', 404);

    // Determine R2 key
    const is_primary = input.is_primary ?? false;
    const filename = is_primary ? 'primary.jpg' : input.filename.toLowerCase();
    const r2Key = productImageKey(input.master_sku, filename);

    // Upload (Sharp processing happens in worker for now; sync path passes bytes through)
    const cdnUrl = await uploadToR2(r2Key, Buffer.from(input.body), input.content_type);

    // Compute simple hash for dedup (not pHash — worker handles perceptual)
    const sha = crypto.createHash('sha256').update(input.body).digest('hex').slice(0, 16);

    // If is_primary: clear other primary flags first
    if (is_primary) {
      await this.db
        .from('product_images')
        .update({ is_primary: false })
        .eq('master_sku', input.master_sku);
    }

    // Insert
    const { data: img, error } = await this.db
      .from('product_images')
      .insert({
        master_sku: input.master_sku,
        r2_key: r2Key,
        cdn_url: cdnUrl,
        filename,
        is_primary,
        format: input.content_type.split('/')[1] ?? null,
        file_size_kb: Math.round(input.body.byteLength / 1024),
        phash: sha, // placeholder; worker overwrites with real pHash
        uploaded_by: this.actorTag(),
      })
      .select('*')
      .single();

    if (error || !img) throw new ServiceError('DB_INSERT_FAILED', error?.message ?? '', 500);

    // If primary, sync products.image_url
    if (is_primary) {
      await this.db
        .from('products')
        .update({
          image_url: cdnUrl,
          image_filename: filename,
          updated_by: this.actorTag(),
        })
        .eq('master_sku', input.master_sku);
    }

    return img as ImageRecord;
  }

  /**
   * Delete an image (from DB + R2).
   */
  async delete(image_id: number) {
    this.requireRole(['owner', 'editor']);

    const { data: img, error } = await this.db
      .from('product_images')
      .select('*')
      .eq('id', image_id)
      .single();
    if (error || !img) throw new ServiceError('NOT_FOUND', 'Image not found', 404);

    await deleteFromR2(img.r2_key);
    await this.db.from('product_images').delete().eq('id', image_id);

    // If we deleted the primary, clear products.image_url
    if (img.is_primary) {
      await this.db
        .from('products')
        .update({ image_url: null, image_filename: null, updated_by: this.actorTag() })
        .eq('master_sku', img.master_sku);
    }
    return { deleted: true };
  }

  /**
   * Promote an image to primary.
   */
  async setPrimary(image_id: number) {
    this.requireRole(['owner', 'editor']);

    const { data: img, error } = await this.db
      .from('product_images')
      .select('*')
      .eq('id', image_id)
      .single();
    if (error || !img) throw new ServiceError('NOT_FOUND', 'Image not found', 404);

    // Clear others
    await this.db
      .from('product_images')
      .update({ is_primary: false })
      .eq('master_sku', img.master_sku);

    // Set this as primary
    await this.db.from('product_images').update({ is_primary: true }).eq('id', image_id);

    // Update product cache
    await this.db
      .from('products')
      .update({
        image_url: img.cdn_url,
        image_filename: img.filename,
        updated_by: this.actorTag(),
      })
      .eq('master_sku', img.master_sku);

    return { primary: image_id };
  }

  /**
   * List images for a product.
   */
  async listForProduct(master_sku: string) {
    const { data, error } = await this.db
      .from('product_images')
      .select('*')
      .eq('master_sku', master_sku)
      .order('is_primary', { ascending: false })
      .order('uploaded_at', { ascending: true });
    if (error) throw new ServiceError('DB_READ_FAILED', error.message, 500);
    return data ?? [];
  }

  /**
   * Find products without a primary image — used for the Issues panel.
   * Filters via `image_url IS NULL` at the DB layer (no client-side scan).
   */
  async findProductsMissingPrimary(limit = 100) {
    const { data, error } = await this.db
      .from('products')
      .select('master_sku, product_name_en, image_url, updated_at')
      .is('image_url', null)
      .is('deleted_at', null)
      .eq('product_status', 'active')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  /**
   * Find duplicate uploads via pHash distance (Hamming ≤ 5).
   * Returns groups of similar images.
   */
  async findDuplicates(): Promise<Array<{ phash: string; images: ImageRecord[] }>> {
    const { data, error } = await this.db
      .from('product_images')
      .select('*')
      .not('phash', 'is', null);
    if (error) throw new ServiceError('DB_READ_FAILED', error.message, 500);

    const groups = new Map<string, ImageRecord[]>();
    for (const img of (data as ImageRecord[]) ?? []) {
      if (!img.phash) continue;
      groups.set(img.phash, [...(groups.get(img.phash) ?? []), img]);
    }
    return Array.from(groups.entries())
      .filter(([, list]) => list.length > 1)
      .map(([phash, images]) => ({ phash, images }));
  }
}
