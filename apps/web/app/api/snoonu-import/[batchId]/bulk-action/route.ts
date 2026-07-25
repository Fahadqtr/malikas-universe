/**
 * POST /api/snoonu-import/[batchId]/bulk-action
 *
 * Apply the same review decision to many items at once.
 *
 * Body:
 *   {
 *     item_ids: number[],            // explicit list, OR
 *     filter?: {                     // … applied as bulk selector
 *       match_status?: 'exact' | 'likely' | 'possible' | 'none',
 *       image_status?: 'saved' | 'failed' | 'no_image' | 'low_quality',
 *       has_no_action?: boolean,
 *     },
 *     action: 'create_new' | 'update_existing' | 'skip' | 'needs_manual',
 *   }
 *
 * Notes:
 *   - update_existing only applies to items that already have matched_product_sku.
 *   - Items without a matched product are silently skipped for update_existing.
 *   - Returns { updated: number, skipped: number }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const BulkSchema = z.object({
  item_ids: z.array(z.number().int()).optional(),
  filter: z.object({
    match_status: z.enum(['exact', 'likely', 'possible', 'none']).optional(),
    image_status: z.enum(['saved', 'failed', 'no_image', 'low_quality']).optional(),
    has_no_action: z.boolean().optional(),
  }).optional(),
  action: z.enum(['create_new', 'update_existing', 'skip', 'needs_manual']),
});

type RouteContext = { params: { batchId: string } };

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  // Owner-only gate FIRST — before batchId parse, body parse, admin client, or DB.
  const actor = await requireActor(ROLE_SETS.ownerOnly);

  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return err('BAD_BATCH_ID', 'Invalid batch id', 400);
  }

  const body = BulkSchema.parse(await req.json());
  if (!body.item_ids?.length && !body.filter) {
    return err('NO_SELECTION', 'Provide item_ids or filter', 400);
  }

  const admin = createAdminSupabaseClient();

  // Resolve target item IDs
  let targetIds: number[] = body.item_ids ?? [];
  if (!targetIds.length && body.filter) {
    let q = admin.from('snoonu_import_items').select('id').eq('batch_id', batchId);
    if (body.filter.match_status) q = q.eq('match_status', body.filter.match_status);
    if (body.filter.image_status) q = q.eq('image_status', body.filter.image_status);
    if (body.filter.has_no_action) q = q.is('review_action', null);
    const { data, error } = await q;
    if (error) {
      console.error(`[bulk-action] filter query failed (batchId=${batchId})`, error);
      return err('FILTER_QUERY_FAILED', 'Internal server error', 500);
    }
    targetIds = (data ?? []).map((r) => (r as { id: number }).id);
  }

  if (!targetIds.length) return ok({ updated: 0, skipped: 0, reason: 'no_items_matched' });

  // For update_existing we need each item's matched_product_sku — pull current rows
  if (body.action === 'update_existing') {
    const { data: rows } = await admin
      .from('snoonu_import_items')
      .select('id, matched_product_sku')
      .in('id', targetIds);

    const eligible = (rows ?? []).filter((r) => (r as { matched_product_sku: string | null }).matched_product_sku);
    const eligibleIds = eligible.map((r) => (r as { id: number }).id);
    const skipped = targetIds.length - eligibleIds.length;

    if (!eligibleIds.length) return ok({ updated: 0, skipped, reason: 'none_have_matched_sku' });

    const { error: updErr } = await admin
      .from('snoonu_import_items')
      .update({
        review_action: 'update_existing',
        reviewed_by: actor.id ?? null,
        reviewed_at: new Date().toISOString(),
        status: 'reviewed',
      })
      .in('id', eligibleIds);

    if (updErr) {
      console.error(`[bulk-action] update_existing failed (batchId=${batchId}, count=${eligibleIds.length})`, updErr);
      return err('UPDATE_FAILED', 'Internal server error', 500);
    }
    return ok({ updated: eligibleIds.length, skipped });
  }

  // create_new / skip / needs_manual — straight bulk update
  const { error: updErr } = await admin
    .from('snoonu_import_items')
    .update({
      review_action: body.action,
      reviewed_by: actor.id ?? null,
      reviewed_at: new Date().toISOString(),
      status: 'reviewed',
    })
    .in('id', targetIds);

  if (updErr) {
    console.error(`[bulk-action] bulk update failed (batchId=${batchId}, action=${body.action})`, updErr);
    return err('UPDATE_FAILED', 'Internal server error', 500);
  }
  return ok({ updated: targetIds.length, skipped: 0 });
});
