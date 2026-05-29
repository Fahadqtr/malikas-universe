/**
 * GET /api/snoonu-import/[batchId]/status
 *
 * Returns: batch summary + per-status counts. Used by the UI to poll
 * progress while extraction runs.
 *
 * Shape:
 *   {
 *     batch: { id, label, status, created_at, ... },
 *     counts: { pending, extracting, matched, error, ... },
 *     items_total: number,
 *     match_summary: { exact, likely, possible, none },
 *     last_updated: ISO string
 *   }
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { batchId: string } };

export const GET = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return err('BAD_BATCH_ID', 'Invalid batch id', 400);
  }

  const admin = createAdminSupabaseClient();

  const { data: batch } = await admin
    .from('snoonu_import_batches')
    .select('*')
    .eq('id', batchId)
    .maybeSingle();

  if (!batch) return err('BATCH_NOT_FOUND', `Batch ${batchId} not found`, 404);

  const { data: items } = await admin
    .from('snoonu_import_items')
    .select('status, match_status, image_status, updated_at')
    .eq('batch_id', batchId);

  const counts: Record<string, number> = {};
  const matchSummary: Record<string, number> = { exact: 0, likely: 0, possible: 0, none: 0, pending: 0 };
  const imageSummary: Record<string, number> = {};
  let lastUpdated: string | null = null;

  for (const row of items ?? []) {
    const r = row as { status: string; match_status: string; image_status: string; updated_at: string };
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    matchSummary[r.match_status] = (matchSummary[r.match_status] ?? 0) + 1;
    imageSummary[r.image_status] = (imageSummary[r.image_status] ?? 0) + 1;
    if (!lastUpdated || r.updated_at > lastUpdated) lastUpdated = r.updated_at;
  }

  return ok({
    batch,
    items_total: items?.length ?? 0,
    counts,
    match_summary: matchSummary,
    image_summary: imageSummary,
    last_updated: lastUpdated,
  });
});
