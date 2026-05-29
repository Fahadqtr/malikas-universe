/**
 * PATCH /api/snoonu-import/[batchId]/items/[itemId]
 *
 * Records the operator's review decision for a single import item.
 *
 * Body:
 *   {
 *     action: 'create_new' | 'update_existing' | 'link_variant' | 'skip' | 'needs_manual',
 *     matched_product_sku?: string,  // required for update_existing / link_variant
 *     review_notes?: string,
 *     overrides?: {                   // operator-edited values before apply
 *       name_en?: string,
 *       name_ar?: string,
 *       brand?: string,
 *       main_category?: string,
 *       price?: number,
 *       discount_price?: number,
 *       description_en?: string,
 *       description_ar?: string,
 *     }
 *   }
 *
 * Sets status='reviewed' so apply route knows it's ready.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const PatchSchema = z.object({
  action: z.enum(['create_new', 'update_existing', 'link_variant', 'skip', 'needs_manual']),
  matched_product_sku: z.string().optional().nullable(),
  review_notes: z.string().max(2000).optional(),
  overrides: z.object({
    name_en: z.string().optional(),
    name_ar: z.string().optional(),
    brand: z.string().optional(),
    main_category: z.string().optional(),
    price: z.number().optional(),
    discount_price: z.number().nullable().optional(),
    description_en: z.string().optional(),
    description_ar: z.string().optional(),
  }).optional(),
});

type RouteContext = { params: { batchId: string; itemId: string } };

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  const itemId = Number(params.itemId);
  if (!Number.isInteger(batchId) || !Number.isInteger(itemId)) {
    return err('BAD_IDS', 'Invalid batch or item id', 400);
  }

  const body = PatchSchema.parse(await req.json());

  if ((body.action === 'update_existing' || body.action === 'link_variant') && !body.matched_product_sku) {
    return err('NEEDS_TARGET_SKU', `Action "${body.action}" requires matched_product_sku`, 400);
  }

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // Load current item to merge overrides into raw_payload
  const { data: existing } = await admin
    .from('snoonu_import_items')
    .select('id, batch_id, raw_payload')
    .eq('id', itemId)
    .eq('batch_id', batchId)
    .maybeSingle();

  if (!existing) return err('ITEM_NOT_FOUND', `Item ${itemId} not found in batch ${batchId}`, 404);

  const mergedRaw = {
    ...(existing.raw_payload as Record<string, unknown> ?? {}),
    overrides: body.overrides ?? {},
  };

  const { error: updErr } = await admin
    .from('snoonu_import_items')
    .update({
      review_action: body.action,
      matched_product_sku: body.matched_product_sku ?? null,
      review_notes: body.review_notes ?? null,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      status: 'reviewed',
      raw_payload: mergedRaw,
    })
    .eq('id', itemId);

  if (updErr) return err('UPDATE_FAILED', updErr.message, 500);

  return ok({ id: itemId, action: body.action, status: 'reviewed' });
});
