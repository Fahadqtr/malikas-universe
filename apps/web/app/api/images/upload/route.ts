/**
 * POST /api/images/upload
 *
 * Multipart body:
 *   - file (required)         the image file
 *   - master_sku (required)   target product
 *   - is_primary (optional)   "true" to set as primary
 *
 * Phase 5: uses Supabase Storage (bucket: product-images).
 * Sync upload, no queue. Returns the public URL.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { uploadImage } from '@/lib/supabase/storage';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot upload images`, 403);
  }

  const form = await req.formData();
  const file = form.get('file') as File | null;
  const master_sku = form.get('master_sku') as string | null;
  const is_primary = form.get('is_primary') === 'true';

  if (!file) return err('NO_FILE', 'file required', 400);
  if (!master_sku) return err('NO_SKU', 'master_sku required', 400);
  if (!ALLOWED.has(file.type)) return err('BAD_FORMAT', `Type ${file.type} not allowed`, 400);
  if (file.size > MAX_BYTES) return err('TOO_LARGE', 'Max 5 MB', 400);

  const admin = createAdminSupabaseClient();

  // Confirm product exists + is not deleted
  const { data: product, error: prodErr } = await admin
    .from('products')
    .select('master_sku')
    .eq('master_sku', master_sku)
    .is('deleted_at', null)
    .maybeSingle();
  if (prodErr) return err('DB_ERROR', prodErr.message, 500);
  if (!product) return err('NO_PRODUCT', 'Product not found', 404);

  // Read file bytes
  const buffer = new Uint8Array(await file.arrayBuffer());

  // Pick filename: primary always uses primary.{ext} (replacing any existing)
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const filename = is_primary
    ? `primary.${ext}`
    : file.name.toLowerCase().replace(/[^a-z0-9.]/g, '-');

  // Upload to Supabase Storage
  const { path, url } = await uploadImage({
    master_sku,
    filename,
    content_type: file.type,
    body: buffer,
    upsert: true,
  });

  // If primary: clear other primary flags on this product
  if (is_primary) {
    await admin.from('product_images').update({ is_primary: false }).eq('master_sku', master_sku);
  }

  // Delete any existing row pointing at this storage path (re-upload of same image)
  await admin.from('product_images').delete().eq('r2_key', path);

  // Insert image record (re-uses r2_key column for storage path)
  const { data: imageRow, error: insertErr } = await admin
    .from('product_images')
    .insert({
      master_sku,
      r2_key: path,
      cdn_url: url,
      filename,
      is_primary,
      format: ext,
      file_size_kb: Math.round(buffer.byteLength / 1024),
      uploaded_by: actor.email,
    })
    .select('*')
    .single();

  if (insertErr) return err('DB_INSERT_FAILED', insertErr.message, 500);

  // Update products.image_url if primary
  if (is_primary) {
    await admin
      .from('products')
      .update({
        image_url: url,
        image_filename: filename,
        updated_by: actor.email,
      })
      .eq('master_sku', master_sku);
  }

  return ok({ image: imageRow, url, path }, 201);
});
