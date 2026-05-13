/**
 * POST /api/bulk-ai/upload
 *
 * Multipart body: { file: File }
 *
 * Uploads an image to `product-images/bulk-temp/{uuid}.{ext}` and returns
 * the public URL. Used by /bulk-ai page for queueing many files.
 *
 * Files are NOT linked to any product. Future phases will:
 *   1. Match each file's original filename → master_sku
 *   2. Run Snoonu image processor on the bytes
 *   3. Run AI Autofill on the URL
 *   4. Promote from bulk-temp/ → products/{sku}/primary.jpg
 *
 * Cleanup: a future n8n job can delete files older than 7 days.
 */
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { STORAGE_BUCKET, publicImageUrl } from '@/lib/supabase/storage';

export const runtime = 'nodejs';
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot upload`, 403);
  }

  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return err('NO_FILE', 'file required', 400);
  if (!ALLOWED.has(file.type)) return err('BAD_FORMAT', `Type ${file.type} not allowed`, 400);
  if (file.size > MAX_BYTES) return err('TOO_LARGE', 'Max 5 MB per file', 400);

  const originalFilename = file.name;
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const id = crypto.randomUUID();
  const path = `bulk-temp/${id}.${ext}`;

  const buffer = new Uint8Array(await file.arrayBuffer());
  const admin = createAdminSupabaseClient();

  const { error: uploadErr } = await admin.storage.from(STORAGE_BUCKET).upload(path, buffer, {
    contentType: file.type,
    upsert: false,
    cacheControl: '3600',
  });
  if (uploadErr) return err('STORAGE_UPLOAD_FAILED', uploadErr.message, 500);

  const url = publicImageUrl(path);

  return ok({
    id,                                  // client-side correlation key
    path,                                // storage path
    url,                                 // public URL (for preview + future AI)
    original_filename: originalFilename, // preserved for future SKU matching
    size_bytes: file.size,
    content_type: file.type,
    uploaded_at: new Date().toISOString(),
  });
});
