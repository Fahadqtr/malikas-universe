/**
 * GET /api/snoonu-import/[batchId]/items
 *
 * Paginated list of items in a batch, with filtering for the review screen.
 *
 * Query params:
 *   ?status=pending|extracting|matched|error|reviewed|applied|skipped
 *   ?match=exact|likely|possible|none
 *   ?action=create_new|update_existing|link_variant|skip|null
 *   ?image=saved|failed|no_image|low_quality
 *   ?has_variants=true|false
 *   ?page=1&limit=50
 *
 * Returns: { items, page, limit, total }
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { batchId: string } };

export const GET = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return err('BAD_BATCH_ID', 'Invalid batch id', 400);
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const match = url.searchParams.get('match');
  const action = url.searchParams.get('action');
  const image = url.searchParams.get('image');
  const hasVariants = url.searchParams.get('has_variants');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = (page - 1) * limit;

  const admin = createAdminSupabaseClient();

  let query = admin
    .from('snoonu_import_items')
    .select('*', { count: 'exact' })
    .eq('batch_id', batchId);

  if (status) query = query.eq('status', status);
  if (match) query = query.eq('match_status', match);
  if (action === 'null') query = query.is('review_action', null);
  else if (action) query = query.eq('review_action', action);
  if (image) query = query.eq('image_status', image);

  query = query
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) return err('QUERY_FAILED', error.message, 500);

  // has_variants filter applied in JS (variant info lives in raw_payload)
  let filtered = data ?? [];
  if (hasVariants === 'true' || hasVariants === 'false') {
    const want = hasVariants === 'true';
    filtered = filtered.filter((row) => {
      const rp = (row as { raw_payload?: { variant_count?: number } }).raw_payload;
      const n = rp?.variant_count ?? 0;
      return want ? n > 0 : n === 0;
    });
  }

  return ok({
    items: filtered,
    page,
    limit,
    total: count ?? filtered.length,
  });
});
