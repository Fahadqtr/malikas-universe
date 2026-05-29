/**
 * POST /api/snoonu-import/[batchId]/items/[itemId]/enrich
 *
 * Runs AI enrichment on a single item. Fills missing bilingual fields,
 * descriptions, and keywords. Optionally also runs the image quality scorer
 * if the item has a saved image.
 *
 * Body: { include_image_qc?: boolean }   (default: true if image_status='saved')
 *
 * Writes:
 *   - raw_payload.enriched = Enrichment object
 *   - raw_payload.image_quality_report = report
 *   - ai_enriched = true
 *   - ai_filled_fields = list of fields populated
 *   - image_quality_issues = updated with AI findings
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import { enrichExtractedProduct, scoreImageQuality, quickImageCheck } from '@/lib/snoonu/enricher';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Schema = z.object({
  include_image_qc: z.boolean().optional(),
});

type RouteContext = { params: { batchId: string; itemId: string } };

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  const itemId = Number(params.itemId);
  if (!Number.isInteger(batchId) || !Number.isInteger(itemId)) {
    return err('BAD_IDS', 'Invalid batch/item id', 400);
  }

  const body = Schema.parse(await req.json().catch(() => ({})));

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  const { data: item } = await admin
    .from('snoonu_import_items')
    .select('*')
    .eq('id', itemId)
    .eq('batch_id', batchId)
    .maybeSingle();

  if (!item) return err('ITEM_NOT_FOUND', 'Item not found', 404);

  const rawPayload = (item.raw_payload as Record<string, unknown> | null) ?? {};
  const variants =
    (rawPayload.variants as Array<{ variant_type: string; variant_value: string }> | undefined) ?? [];
  const categoryInf =
    (rawPayload.category_inference as { category: string } | undefined)?.category ?? 'Trending Products';

  // 1. Enrichment
  const enrichResult = await enrichExtractedProduct({
    name_en: item.extracted_name_en,
    name_ar: item.extracted_name_ar,
    brand: item.extracted_brand,
    category: categoryInf,
    product_type: item.extracted_product_type,
    description_en: item.extracted_description_en,
    description_ar: item.extracted_description_ar,
    price: item.extracted_price,
    variants,
  });

  // 2. Optional image QC
  const shouldQc =
    body.include_image_qc ?? (item.image_status === 'saved' && !!item.imported_image_url);

  let imageQc: Awaited<ReturnType<typeof scoreImageQuality>>['data'] | null = null;

  if (shouldQc && item.imported_image_url) {
    try {
      const qc = await scoreImageQuality(
        { type: 'url', url: item.imported_image_url },
        { dims: null },
      );
      imageQc = qc.data;
    } catch (e) {
      // QC is best-effort; failure shouldn't block enrichment.
      console.error('[enrich] image QC failed:', e);
    }
  }

  // 3. Merge into raw_payload and persist
  const mergedQualityIssues = Array.from(
    new Set([
      ...((item.image_quality_issues as string[] | null) ?? []),
      ...(imageQc?.issues ?? []),
    ]),
  );

  await admin
    .from('snoonu_import_items')
    .update({
      ai_enriched: true,
      ai_filled_fields: enrichResult.data.filled_fields,
      image_quality_issues: mergedQualityIssues,
      raw_payload: {
        ...rawPayload,
        enriched: enrichResult.data,
        image_quality_report: imageQc,
      },
    })
    .eq('id', itemId);

  return ok({
    item_id: itemId,
    enrichment: enrichResult.data,
    image_quality: imageQc,
    tokens: enrichResult.usage,
  });
});

/**
 * GET — read enrichment status without running anything new.
 * Cheap helper for the review UI to know if AI has already run.
 */
export const GET = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  const itemId = Number(params.itemId);
  const admin = createAdminSupabaseClient();
  const { data: item } = await admin
    .from('snoonu_import_items')
    .select('id, ai_enriched, ai_filled_fields, image_quality_issues, raw_payload')
    .eq('id', itemId)
    .eq('batch_id', batchId)
    .maybeSingle();
  if (!item) return err('ITEM_NOT_FOUND', 'Item not found', 404);

  const rp = (item.raw_payload as { enriched?: unknown; image_quality_report?: unknown } | null) ?? {};
  return ok({
    item_id: itemId,
    ai_enriched: item.ai_enriched,
    ai_filled_fields: item.ai_filled_fields ?? [],
    enrichment: rp.enriched ?? null,
    image_quality: rp.image_quality_report ?? null,
    image_quality_issues: item.image_quality_issues ?? [],
    quick_check_hint: quickImageCheck({ width: null, height: null, size_bytes: 0 }),
  });
});
