/**
 * POST /api/snoonu-import/[batchId]/enrich-all
 *
 * Run AI enrichment on every item in the batch that needs it.
 *
 * "Needs it" = missing any of: name_ar, description_en, description_ar,
 *              OR has no AI run yet AND is missing >= 2 bilingual fields.
 *
 * Body: { include_image_qc?: boolean, only_missing?: boolean }
 *
 * Returns: { total, enriched, skipped, errors[], tokens }
 *
 * Runs sequentially with small delays to stay under rate limits.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import { enrichExtractedProduct, scoreImageQuality } from '@/lib/snoonu/enricher';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Schema = z.object({
  include_image_qc: z.boolean().optional(),
  only_missing: z.boolean().optional(),
  item_ids: z.array(z.number().int()).optional(),
});

type RouteContext = { params: { batchId: string } };

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return err('BAD_BATCH_ID', 'Invalid batch id', 400);
  }

  const body = Schema.parse(await req.json().catch(() => ({})));
  const includeQc = body.include_image_qc ?? false;
  const onlyMissing = body.only_missing ?? true;

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  let q = admin
    .from('snoonu_import_items')
    .select(
      'id, extracted_name_en, extracted_name_ar, extracted_brand, extracted_product_type, extracted_description_en, extracted_description_ar, extracted_price, imported_image_url, image_status, image_quality_issues, ai_enriched, raw_payload',
    )
    .eq('batch_id', batchId)
    .in('status', ['matched', 'reviewed']);

  if (body.item_ids?.length) q = q.in('id', body.item_ids);
  if (onlyMissing) q = q.eq('ai_enriched', false);

  const { data: items } = await q;
  const rows = items ?? [];

  let enriched = 0;
  let skipped = 0;
  const errors: Array<{ item_id: number; reason: string }> = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (const item of rows) {
    try {
      const rawPayload = (item.raw_payload as Record<string, unknown> | null) ?? {};
      const variants =
        (rawPayload.variants as Array<{ variant_type: string; variant_value: string }> | undefined) ?? [];
      const categoryInf =
        (rawPayload.category_inference as { category: string } | undefined)?.category ?? 'Trending Products';

      const enrichRes = await enrichExtractedProduct({
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
      totalTokensIn += enrichRes.usage.input;
      totalTokensOut += enrichRes.usage.output;

      let imageQc = null;
      if (includeQc && item.image_status === 'saved' && item.imported_image_url) {
        try {
          const qc = await scoreImageQuality(
            { type: 'url', url: item.imported_image_url },
            { dims: null },
          );
          imageQc = qc.data;
          totalTokensIn += qc.usage.input;
          totalTokensOut += qc.usage.output;
        } catch (qcErr) {
          console.error(`[enrich-all] QC failed for item ${item.id}:`, qcErr);
        }
      }

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
          ai_filled_fields: enrichRes.data.filled_fields,
          image_quality_issues: mergedQualityIssues,
          raw_payload: {
            ...rawPayload,
            enriched: enrichRes.data,
            image_quality_report: imageQc,
          },
        })
        .eq('id', item.id);

      enriched++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ item_id: item.id, reason: msg });
      skipped++;
    }

    // Polite gap between AI calls — 250ms feels right for Haiku rate limits
    await new Promise((r) => setTimeout(r, 250));
  }

  return ok({
    total: rows.length,
    enriched,
    skipped,
    errors,
    tokens: { input: totalTokensIn, output: totalTokensOut },
  });
});
