/**
 * POST /api/snoonu-import/[batchId]/process
 *
 * Runs the extraction → image pull → variant detection → matching pipeline
 * for every pending item in the batch. This is intentionally synchronous-ish
 * (long-running, up to 5 min) — the UI polls `/status` while it runs.
 *
 * For production scale, this should be moved to a background queue (e.g.
 * Supabase Edge Functions cron). For now, run it inline for simplicity.
 *
 * Steps per item:
 *   1. Set status='extracting'
 *   2. Call extractSnoonuProduct(url)
 *   3. On success, store extracted fields + raw_payload
 *   4. Infer master category, generate parent SKU
 *   5. pullImageForSku(sku, image_url) → store image
 *   6. detectVariants() → store variant_group_id and write variant items
 *   7. matchExistingProduct() → store match_status, matched_product_sku
 *   8. Set status='matched' (ready for review)
 *
 * Body: none (or { force?: boolean } to re-run already-processed items)
 *
 * Returns: { batch_id, processed, succeeded, failed, status }
 */

import { NextRequest } from 'next/server';
import type { Json } from '@malikas/db';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { extractSnoonuProduct, type ExtractedProduct } from '@/lib/snoonu/extractor';
import { inferMasterCategory } from '@/lib/master-categories';
import { generateParentSku } from '@/lib/sku-generator';
import { pullImageForSku } from '@/lib/snoonu/image-pull';
import { detectVariants } from '@/lib/snoonu/variant-detector';
import { matchExistingProduct } from '@/lib/snoonu/matcher';
import { quickImageCheck } from '@/lib/snoonu/enricher';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 min

type RouteContext = { params: { batchId: string } };

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return err('BAD_BATCH_ID', 'Invalid batch id', 400);
  }

  const admin = createAdminSupabaseClient();

  // 1. Verify batch exists + lock to 'extracting'
  const { data: batch } = await admin
    .from('snoonu_import_batches')
    .select('id, status, total_items')
    .eq('id', batchId)
    .maybeSingle();

  if (!batch) return err('BATCH_NOT_FOUND', `Batch ${batchId} not found`, 404);
  if (batch.status === 'applied') return err('ALREADY_APPLIED', 'Batch already applied', 409);

  await admin
    .from('snoonu_import_batches')
    .update({ status: 'extracting' })
    .eq('id', batchId);

  // 2. Load pending items
  const { data: items } = await admin
    .from('snoonu_import_items')
    .select('id, source_url, status')
    .eq('batch_id', batchId)
    .in('status', ['pending', 'error']) // retry errored items
    .order('id', { ascending: true });

  const pending = items ?? [];
  let succeeded = 0;
  let failed = 0;
  let imageFailed = 0;
  let variantCount = 0;

  // 3. Process each item — sequential to stay polite with Snoonu
  for (const item of pending) {
    try {
      await admin
        .from('snoonu_import_items')
        .update({ status: 'extracting' })
        .eq('id', item.id);

      // 3a. Extract
      const extracted = await extractSnoonuProduct(item.source_url);
      if (!extracted.ok) {
        await admin.from('snoonu_import_items').update({
          status: 'error',
          error_message: `extract:${extracted.reason}`,
        }).eq('id', item.id);
        failed++;
        continue;
      }

      // 3b. Infer master category + generate parent SKU
      const cat = inferMasterCategory({
        brand: extracted.brand,
        product_type: extracted.product_type,
        product_name: extracted.name_en,
        category_hint: extracted.category_hint,
        tags: extracted.tags,
      });
      const parentSku = await generateParentSku(cat.category);

      // 3c. Pull image (if any)
      let imageBlock: Partial<{
        image_filename: string;
        image_storage_path: string;
        imported_image_url: string;
        image_status: 'saved' | 'failed' | 'no_image';
        image_quality_issues: string[];
      }> = {};

      if (extracted.image_url) {
        const pulled = await pullImageForSku(parentSku, extracted.image_url, { overwrite: true });
        if (pulled.ok) {
          const quick = quickImageCheck({
            width: pulled.width,
            height: pulled.height,
            size_bytes: pulled.size_bytes,
          });
          imageBlock = {
            image_filename: pulled.image_filename,
            image_storage_path: pulled.storage_path,
            imported_image_url: pulled.public_url,
            image_status: 'saved',
            image_quality_issues: quick.issues,
          };
        } else {
          imageBlock = { image_status: 'failed', image_quality_issues: [pulled.reason] };
          imageFailed++;
        }
      } else {
        imageBlock = { image_status: 'no_image' };
      }

      // 3d. Variant detection (no DB writes here — variants get saved on apply)
      const variants = detectVariants(extracted, parentSku);
      variantCount += variants.length;

      // 3e. Match against existing products
      const match = await matchExistingProduct(extracted);

      const matchPayload =
        match.kind === 'new'
          ? { match_status: 'none' as const, matched_product_sku: null, match_confidence: null, match_reasons: [] }
          : match.kind === 'exact'
          ? {
              match_status: 'exact' as const,
              matched_product_sku: match.existing.master_sku,
              match_confidence: match.confidence,
              match_reasons: [match.signal],
            }
          : match.kind === 'likely'
          ? {
              match_status: 'likely' as const,
              matched_product_sku: match.existing.master_sku,
              match_confidence: match.confidence,
              match_reasons: [match.signal],
            }
          : {
              match_status: 'possible' as const,
              matched_product_sku: null,
              match_confidence: match.confidence,
              match_reasons: match.candidates.map((c) => `${c.signal}:${c.row.master_sku ?? '?'}`),
            };

      // 3f. Persist everything to the import item
      await admin.from('snoonu_import_items').update({
        ...flattenExtracted(extracted),
        source_image_url: extracted.image_url,
        generated_sku: parentSku,
        ...imageBlock,
        ...matchPayload,
        is_variant: false, // parent
        status: 'matched',
        raw_payload: {
          extracted,
          variants,
          variant_count: variants.length,
          category_inference: cat,
        } as unknown as Json,
      }).eq('id', item.id);

      succeeded++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await admin
        .from('snoonu_import_items')
        .update({ status: 'error', error_message: `process:${msg}` })
        .eq('id', item.id);
    }
  }

  // 4. Update batch counts + flip to review_ready
  await admin
    .from('snoonu_import_batches')
    .update({
      extracted_count: succeeded,
      matched_count: succeeded,
      variant_count: variantCount,
      image_failed_count: imageFailed,
      blocked_count: failed,
      status: 'review_ready',
    })
    .eq('id', batchId);

  return ok({
    batch_id: batchId,
    processed: pending.length,
    succeeded,
    failed,
    image_failed: imageFailed,
    variant_count: variantCount,
    status: 'review_ready',
  });
});

/** Map ExtractedProduct → snoonu_import_items column names. */
function flattenExtracted(e: ExtractedProduct) {
  return {
    source_product_id: e.source_product_id,
    extracted_name_en: e.name_en,
    extracted_name_ar: e.name_ar,
    extracted_brand: e.brand,
    extracted_category: e.category_hint,
    extracted_subcategory: e.subcategory,
    extracted_product_type: e.product_type,
    extracted_price: e.price,
    extracted_discount_price: e.discount_price,
    extracted_currency: e.currency,
    extracted_sku: e.sku,
    extracted_barcode: e.barcode,
    extracted_description_en: e.description_en,
    extracted_description_ar: e.description_ar,
  };
}
