/**
 * Supabase Storage helper.
 * Bucket: product-images (public read, authenticated write).
 * Phase 5 replaces R2 with Supabase Storage for simpler local setup.
 */
import { createAdminSupabaseClient, createServerSupabaseClient } from './server';

export const STORAGE_BUCKET = 'product-images';

/**
 * Build the storage path for a product image.
 * Pattern: products/{master_sku_lowercased}/{filename}
 */
export function productImageStoragePath(
  masterSku: string,
  filename = 'primary.jpg',
): string {
  return `products/${masterSku.toLowerCase()}/${filename.toLowerCase()}`;
}

/**
 * Build the public CDN URL for an uploaded image.
 */
export function publicImageUrl(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '') ?? '';
  return `${base}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
}

/**
 * Upload a buffer to Supabase Storage.
 * Returns the public URL.
 */
export async function uploadImage(opts: {
  master_sku: string;
  filename: string;
  content_type: string;
  body: Uint8Array;
  upsert?: boolean;
}): Promise<{ path: string; url: string }> {
  const supabase = createAdminSupabaseClient();
  const path = productImageStoragePath(opts.master_sku, opts.filename);

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, opts.body, {
    contentType: opts.content_type,
    upsert: opts.upsert ?? true,
    cacheControl: '31536000',
  });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  return { path, url: publicImageUrl(path) };
}

/**
 * Delete an image from storage.
 */
export async function deleteImage(storagePath: string): Promise<void> {
  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

/**
 * List images for a product.
 */
export async function listProductImages(masterSku: string): Promise<string[]> {
  const supabase = createAdminSupabaseClient();
  const prefix = `products/${masterSku.toLowerCase()}`;
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(prefix);
  if (error) throw new Error(`Storage list failed: ${error.message}`);
  return (data ?? []).map((f) => `${prefix}/${f.name}`);
}
