/**
 * POST /api/snoonu-import/start
 *
 * Creates a new snoonu_import_batches row in `pending` status, queues
 * up snoonu_import_items, and kicks off background extraction.
 *
 * Body shape (one of):
 *   { mode: 'single_url',   url: string,          label?: string }
 *   { mode: 'category_url', url: string,          label?: string }
 *   { mode: 'paste_list',   urls: string[],       label?: string }
 *   { mode: 'csv_upload',   filename: string,
 *                            urls: string[],      label?: string }
 *
 * Returns: { batch_id, total_items, status }
 *
 * Notes:
 *   - We DON'T scrape category listings here (that's a follow-up task).
 *     For category_url mode, the caller should send the URLs already
 *     scraped from the listing page; otherwise we treat it as single_url.
 *   - Extraction itself runs asynchronously via the process route.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

const StartSchema = z.object({
  mode: z.enum(['single_url', 'category_url', 'paste_list', 'csv_upload', 'xlsx_upload', 'html_paste']),
  url: z.string().url().optional(),
  urls: z.array(z.string().url()).optional(),
  filename: z.string().optional(),
  label: z.string().max(120).optional(),
});

function isSnoonuUrl(u: string): boolean {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host.endsWith('snoonu.com');
  } catch {
    return false;
  }
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = await req.json();
  const input = StartSchema.parse(body);

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  // Build URL list based on mode
  let urls: string[] = [];
  if (input.mode === 'single_url') {
    if (!input.url) return err('MISSING_URL', 'url is required for single_url mode', 400);
    urls = [input.url];
  } else if (input.mode === 'category_url') {
    if (!input.url) return err('MISSING_URL', 'url is required for category_url mode', 400);
    urls = input.urls && input.urls.length > 0 ? input.urls : [input.url];
  } else {
    if (!input.urls || input.urls.length === 0) {
      return err('MISSING_URLS', 'urls array is required', 400);
    }
    urls = input.urls;
  }

  // Deduplicate + Snoonu-only filter (we don't extract other platforms yet)
  const cleanUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
  const validUrls = cleanUrls.filter(isSnoonuUrl);
  const rejected = cleanUrls.filter((u) => !isSnoonuUrl(u));

  if (validUrls.length === 0) {
    return err('NO_SNOONU_URLS', 'No valid Snoonu URLs in input', 400, { rejected });
  }
  if (validUrls.length > 500) {
    return err('TOO_MANY_URLS', 'Maximum 500 URLs per batch', 400);
  }

  const admin = createAdminSupabaseClient();

  // 1. Create the batch
  const { data: batchRow, error: batchErr } = await admin
    .from('snoonu_import_batches')
    .insert({
      label: input.label ?? null,
      source_mode: input.mode,
      source_input: input.url ?? input.filename ?? `paste:${validUrls.length} urls`,
      total_items: validUrls.length,
      status: 'pending',
      created_by: user.id,
    })
    .select('id')
    .single();

  if (batchErr || !batchRow) {
    return err('BATCH_INSERT_FAILED', batchErr?.message ?? 'unknown', 500);
  }

  const batchId = (batchRow as { id: number }).id;

  // 2. Insert all items in pending state
  const itemRows = validUrls.map((u) => ({
    batch_id: batchId,
    source_platform: 'snoonu',
    source_url: u,
    status: 'pending' as const,
  }));

  const { error: itemsErr } = await admin
    .from('snoonu_import_items')
    .insert(itemRows);

  if (itemsErr) {
    // Roll back the batch so we don't leave orphans
    await admin.from('snoonu_import_batches').delete().eq('id', batchId);
    return err('ITEMS_INSERT_FAILED', itemsErr.message, 500);
  }

  return ok({
    batch_id: batchId,
    total_items: validUrls.length,
    rejected_urls: rejected,
    status: 'pending',
    next: `POST /api/snoonu-import/${batchId}/process`,
  });
});
