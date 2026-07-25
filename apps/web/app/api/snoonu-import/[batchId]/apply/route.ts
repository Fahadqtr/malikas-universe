/**
 * POST /api/snoonu-import/[batchId]/apply
 *
 * Materialize reviewed items into the products table.
 *
 * Lifecycle on each item:
 *   reviewed (create_new)      → INSERT products + insert product_images + log source_link
 *   reviewed (update_existing) → UPDATE products by matched_product_sku, append image
 *   reviewed (link_variant)    → INSERT product_variants row (parent → variant)
 *   reviewed (skip)            → status='skipped', do nothing
 *   reviewed (needs_manual)    → leave for manual handling
 *
 * Per-item failures don't stop the batch — they're logged and we continue.
 *
 * Body: { dry_run?: boolean }
 * Returns: { applied, skipped, failed, errors[] }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import type { Database } from '@malikas/db';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { inferMasterCategory } from '@/lib/master-categories';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ApplySchema = z.object({
  dry_run: z.boolean().optional(),
});

type RouteContext = { params: { batchId: string } };

type ReviewedItem = {
  id: number;
  source_url: string;
  source_image_url: string | null;
  extracted_name_en: string | null;
  extracted_name_ar: string | null;
  extracted_brand: string | null;
  extracted_category: string | null;
  extracted_subcategory: string | null;
  extracted_product_type: string | null;
  extracted_price: number | null;
  extracted_discount_price: number | null;
  extracted_sku: string | null;
  extracted_barcode: string | null;
  extracted_description_en: string | null;
  extracted_description_ar: string | null;
  generated_sku: string | null;
  image_filename: string | null;
  image_storage_path: string | null;
  imported_image_url: string | null;
  matched_product_sku: string | null;
  review_action: 'create_new' | 'update_existing' | 'link_variant' | 'skip' | 'needs_manual';
  raw_payload: {
    overrides?: Partial<{
      name_en: string;
      name_ar: string;
      brand: string;
      main_category: string;
      price: number;
      discount_price: number | null;
      description_en: string;
      description_ar: string;
    }>;
    variants?: Array<{
      variant_type: string;
      variant_value: string;
      variant_code: string;
      variant_sku: string;
      sort_order: number;
      is_default: boolean;
    }>;
    category_inference?: { category: string };
  } | null;
};

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  // Owner-only gate FIRST — before batchId parse, body parse, admin client, or DB.
  await requireActor(ROLE_SETS.ownerOnly);

  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    return err('BAD_BATCH_ID', 'Invalid batch id', 400);
  }

  const body = ApplySchema.parse(await req.json().catch(() => ({})));
  const dryRun = body.dry_run ?? false;

  const admin = createAdminSupabaseClient();

  // 1. Move batch into 'applying' (unless dry run)
  if (!dryRun) {
    await admin.from('snoonu_import_batches').update({ status: 'applying' }).eq('id', batchId);
  }

  // 2. Pull all reviewed items
  const { data: items } = await admin
    .from('snoonu_import_items')
    .select(
      'id, source_url, source_image_url, extracted_name_en, extracted_name_ar, extracted_brand, extracted_category, extracted_subcategory, extracted_product_type, extracted_price, extracted_discount_price, extracted_sku, extracted_barcode, extracted_description_en, extracted_description_ar, generated_sku, image_filename, image_storage_path, imported_image_url, matched_product_sku, review_action, raw_payload',
    )
    .eq('batch_id', batchId)
    .eq('status', 'reviewed');

  if (!items || items.length === 0) {
    return ok({ applied: 0, skipped: 0, failed: 0, errors: [], message: 'no_reviewed_items' });
  }

  let applied = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ item_id: number; reason: string }> = [];

  // 3. Resolve brand/category lookups once
  const brandsLookup = await loadBrandsLookup(admin);
  const categoriesLookup = await loadCategoriesLookup(admin);

  for (const itemRaw of items) {
    const item = itemRaw as ReviewedItem;
    try {
      switch (item.review_action) {
        case 'skip':
        case 'needs_manual':
          if (!dryRun) {
            await admin
              .from('snoonu_import_items')
              .update({ status: item.review_action === 'skip' ? 'skipped' : 'reviewed' })
              .eq('id', item.id);
          }
          skipped++;
          break;

        case 'create_new': {
          const result = await applyCreateNew(admin, item, brandsLookup, categoriesLookup, batchId, dryRun);
          if (result.ok) applied++;
          else { failed++; errors.push({ item_id: item.id, reason: result.reason }); }
          break;
        }

        case 'update_existing': {
          const result = await applyUpdateExisting(admin, item, dryRun);
          if (result.ok) applied++;
          else { failed++; errors.push({ item_id: item.id, reason: result.reason }); }
          break;
        }

        case 'link_variant': {
          const result = await applyLinkVariant(admin, item, dryRun);
          if (result.ok) applied++;
          else { failed++; errors.push({ item_id: item.id, reason: result.reason }); }
          break;
        }

        default:
          skipped++;
      }
    } catch (e) {
      failed++;
      console.error(`[snoonu-import/apply] item ${item.id} failed (batch ${batchId})`, e);
      errors.push({ item_id: item.id, reason: 'Import apply failed' });
      if (!dryRun) {
        await admin
          .from('snoonu_import_items')
          .update({ status: 'error', error_message: 'Import apply failed' })
          .eq('id', item.id);
      }
    }
  }

  // 4. Finalize batch
  if (!dryRun) {
    await admin
      .from('snoonu_import_batches')
      .update({
        applied_count: applied,
        status: failed > 0 ? 'review_ready' : 'applied',
        completed_at: failed > 0 ? null : new Date().toISOString(),
        error_message: failed > 0 ? `${failed} items failed` : null,
      })
      .eq('id', batchId);
  }

  return ok({ applied, skipped, failed, errors, dry_run: dryRun });
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function loadBrandsLookup(admin: ReturnType<typeof createAdminSupabaseClient>): Promise<Map<string, number>> {
  const { data } = await admin.from('brands').select('id, name');
  const map = new Map<string, number>();
  for (const r of data ?? []) {
    const row = r as { id: number; name: string };
    map.set(row.name.toLowerCase().trim(), row.id);
  }
  return map;
}

async function loadCategoriesLookup(admin: ReturnType<typeof createAdminSupabaseClient>): Promise<Map<string, number>> {
  const { data } = await admin.from('categories').select('id, name');
  const map = new Map<string, number>();
  for (const r of data ?? []) {
    const row = r as { id: number; name: string };
    map.set(row.name.toLowerCase().trim(), row.id);
  }
  return map;
}

async function resolveBrandId(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  brandsLookup: Map<string, number>,
  brandName: string | null | undefined,
): Promise<number | null> {
  if (!brandName) return null;
  const key = brandName.toLowerCase().trim();
  const hit = brandsLookup.get(key);
  if (hit) return hit;
  // Create on-the-fly so import never blocks on unknown brands
  const { data, error } = await admin
    .from('brands')
    .insert({ name: brandName.trim() })
    .select('id')
    .single();
  if (error || !data) return null;
  const id = (data as { id: number }).id;
  brandsLookup.set(key, id);
  return id;
}

function resolveCategoryId(
  categoriesLookup: Map<string, number>,
  categoryName: string,
): number | null {
  return categoriesLookup.get(categoryName.toLowerCase().trim()) ?? null;
}

async function applyCreateNew(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  item: ReviewedItem,
  brandsLookup: Map<string, number>,
  categoriesLookup: Map<string, number>,
  batchId: number,
  dryRun: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!item.generated_sku) return { ok: false, reason: 'no_generated_sku' };

  const ov = item.raw_payload?.overrides ?? {};
  const nameEn = ov.name_en ?? item.extracted_name_en;
  const nameAr = ov.name_ar ?? item.extracted_name_ar;
  if (!nameEn || !nameAr) return { ok: false, reason: 'missing_bilingual_name' };

  const brandName = ov.brand ?? item.extracted_brand ?? 'Unknown';
  const brandId = await resolveBrandId(admin, brandsLookup, brandName);
  if (!brandId) return { ok: false, reason: 'brand_resolve_failed' };

  // Resolve category — prefer override, fall back to inference cached in raw_payload
  const categoryName =
    ov.main_category ??
    item.raw_payload?.category_inference?.category ??
    inferMasterCategory({
      brand: item.extracted_brand,
      product_type: item.extracted_product_type,
      product_name: item.extracted_name_en,
      category_hint: item.extracted_category,
    }).category;
  const categoryId = resolveCategoryId(categoriesLookup, categoryName);
  if (!categoryId) return { ok: false, reason: `category_not_found:${categoryName}` };

  const price = ov.price ?? item.extracted_price ?? 0;
  const discountPrice = ov.discount_price ?? item.extracted_discount_price ?? null;

  if (dryRun) return { ok: true };

  // Insert product
  const { error: prodErr } = await admin.from('products').insert({
    master_sku: item.generated_sku,
    snoonu_sku: item.extracted_sku,
    barcode: item.extracted_barcode,
    snoonu_url: item.source_url,
    product_name_en: nameEn,
    product_name_ar: nameAr,
    brand_id: brandId,
    category_id: categoryId,
    product_type: item.extracted_product_type,
    price,
    discount_price: discountPrice,
    image_url: item.imported_image_url,
    image_filename: item.image_filename,
    description_en: ov.description_en ?? item.extracted_description_en,
    description_ar: ov.description_ar ?? item.extracted_description_ar,
    source_platform: 'snoonu',
    product_status: 'draft',
  });

  if (prodErr) {
    console.error(`[snoonu-import/apply] product insert failed (item ${item.id})`, prodErr);
    return { ok: false, reason: 'Import apply failed' };
  }

  // product_images row
  if (item.imported_image_url && item.image_storage_path) {
    await admin.from('product_images').insert({
      master_sku: item.generated_sku,
      r2_key: item.image_storage_path,
      cdn_url: item.imported_image_url,
      filename: item.image_filename ?? '',
      is_primary: true,
      source_platform: 'snoonu',
      source_url: item.source_image_url,
      import_item_id: item.id,
    });
  }

  // Audit row
  await admin.from('product_source_links').insert({
    master_sku: item.generated_sku,
    source_platform: 'snoonu',
    source_url: item.source_url,
    import_batch_id: batchId,
    import_item_id: item.id,
  });

  // Mark item applied
  await admin
    .from('snoonu_import_items')
    .update({ status: 'applied' })
    .eq('id', item.id);

  return { ok: true };
}

async function applyUpdateExisting(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  item: ReviewedItem,
  dryRun: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!item.matched_product_sku) return { ok: false, reason: 'no_matched_sku' };

  const ov = item.raw_payload?.overrides ?? {};
  const updates: Record<string, unknown> = {};

  // Only touch fields the operator explicitly chose
  if (ov.price != null) updates.price = ov.price;
  if (ov.discount_price !== undefined) updates.discount_price = ov.discount_price;
  if (ov.description_en) updates.description_en = ov.description_en;
  if (ov.description_ar) updates.description_ar = ov.description_ar;
  if (item.source_url) updates.snoonu_url = item.source_url;
  if (item.extracted_barcode) updates.barcode = item.extracted_barcode;

  if (dryRun) return { ok: true };

  if (Object.keys(updates).length > 0) {
    const { error: updErr } = await admin
      .from('products')
      .update(updates as Database['public']['Tables']['products']['Update'])
      .eq('master_sku', item.matched_product_sku);
    if (updErr) {
      console.error(`[snoonu-import/apply] product update failed (item ${item.id})`, updErr);
      return { ok: false, reason: 'Import apply failed' };
    }
  }

  // Append image if we pulled one
  if (item.imported_image_url && item.image_storage_path) {
    await admin.from('product_images').insert({
      master_sku: item.matched_product_sku,
      r2_key: item.image_storage_path,
      cdn_url: item.imported_image_url,
      filename: item.image_filename ?? '',
      is_primary: false,
      source_platform: 'snoonu',
      source_url: item.source_image_url,
      import_item_id: item.id,
    });
  }

  // Audit
  await admin
    .from('product_source_links')
    .upsert({
      master_sku: item.matched_product_sku,
      source_platform: 'snoonu',
      source_url: item.source_url,
      import_item_id: item.id,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'master_sku,source_platform,source_url' });

  await admin
    .from('snoonu_import_items')
    .update({ status: 'applied' })
    .eq('id', item.id);

  return { ok: true };
}

async function applyLinkVariant(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  item: ReviewedItem,
  dryRun: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!item.matched_product_sku) return { ok: false, reason: 'no_parent_sku' };
  if (!item.generated_sku) return { ok: false, reason: 'no_variant_sku' };

  const variants = item.raw_payload?.variants ?? [];
  if (variants.length === 0) return { ok: false, reason: 'no_variants_detected' };

  if (dryRun) return { ok: true };

  // Insert each detected variant row. The variant's child product must already
  // exist or be created upstream — for now we only link existing matched_product_sku.
  for (const v of variants) {
    await admin.from('product_variants').upsert({
      parent_sku: item.matched_product_sku,
      variant_sku: v.variant_sku,
      variant_type: v.variant_type,
      variant_value: v.variant_value,
      variant_code: v.variant_code,
      sort_order: v.sort_order,
      is_default: v.is_default,
    }, { onConflict: 'parent_sku,variant_sku' });
  }

  await admin
    .from('snoonu_import_items')
    .update({ status: 'applied', is_variant: true, parent_sku: item.matched_product_sku })
    .eq('id', item.id);

  return { ok: true };
}
