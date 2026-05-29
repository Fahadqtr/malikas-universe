/**
 * POST /api/reconciliation/upload
 *
 * Phase 13A: accept an export from any platform (Snoonu, Talabat, Rafeeq,
 * Shopify, internal), parse + normalize, persist into platform_imports +
 * platform_products. Match against the master `products` table.
 *
 * Multipart body:
 *   - file:           CSV / XLSX (max 5 MB, up to 10,000 rows)
 *   - platform:       (optional) explicit platform hint
 *   - label:          (optional) human-friendly batch label
 *
 * Returns:
 *   {
 *     import_id, platform, platform_score,
 *     total_rows, parsed_rows, matched_rows, unmatched_rows,
 *     column_mapping, unmapped_headers,
 *     status: 'ready'
 *   }
 *
 * Matching here is cheap — SKU exact + barcode exact only. Heavier matching
 * runs inside the comparator (Phase 13A.4).
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import { parseFile } from '@malikas/shared';
import {
  normalizeRows,
  type NormalizedProductRow,
  type Platform,
} from '@/lib/reconciliation/normalizer';
import { normalizeProductName, normalizeBrand } from '@/lib/reconciliation/text-normalizer';
import { extractVariantAttrs } from '@/lib/reconciliation/variant-extractor';
import { extractCategory } from '@/lib/reconciliation/category-extractor';

export const runtime = 'nodejs';
export const maxDuration = 120;

const ALLOWED_PLATFORMS: Platform[] = ['snoonu', 'talabat', 'rafeeq', 'shopify', 'internal', 'other'];

export const POST = withErrorHandling(async (req: NextRequest) => {
  const form = await req.formData();
  const file = form.get('file') as File | null;
  const platformHintRaw = (form.get('platform') as string | null) ?? null;
  const label = (form.get('label') as string | null) ?? null;

  if (!file) return err('NO_FILE', 'No file uploaded', 400);
  if (file.size > 5 * 1024 * 1024) return err('FILE_TOO_LARGE', 'Max 5 MB', 400);

  const platformHint =
    platformHintRaw && ALLOWED_PLATFORMS.includes(platformHintRaw as Platform)
      ? (platformHintRaw as Platform)
      : null;

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  // 1. Parse raw file
  const buffer = new Uint8Array(await file.arrayBuffer());
  const parsed = await parseFile(buffer, { filename: file.name, max_rows: 10000 });
  if (parsed.rows.length === 0) return err('EMPTY_FILE', 'No rows found', 400);

  // 2. Normalize to canonical shape
  const norm = normalizeRows(parsed.rows, platformHint ? { platform_hint: platformHint } : {});
  if (norm.platform === 'other' && !platformHint) {
    return err(
      'PLATFORM_UNKNOWN',
      `Could not detect platform from headers. Pass ?platform=snoonu/talabat/rafeeq/shopify/internal explicitly. Headers seen: ${parsed.headers.slice(0, 10).join(', ')}`,
      400,
    );
  }

  // Phase 13A bug-fix: do NOT drop rows that lack a comparable key.
  // Insert everything; flag low-quality rows in the UI instead. This lets
  // operators see exactly what came in and what mapped.
  const comparable = norm.rows;
  const noKey = norm.rows.filter(
    (r) => !r.source_sku && !r.barcode && !r.name_en && !r.name_ar,
  ).length;
  const skipped = 0;

  const admin = createAdminSupabaseClient();

  // 3. Create the import batch row
  const sourceMode = (() => {
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'xlsx' || ext === 'xls') return 'xlsx_upload';
    return 'csv_upload';
  })();

  const { data: importRow, error: importErr } = await admin
    .from('platform_imports')
    .insert({
      platform: norm.platform,
      label: label ?? null,
      source_mode: sourceMode,
      source_filename: file.name,
      column_mapping: norm.column_mapping,
      detected_headers: norm.detected_headers,
      total_rows: norm.rows.length,
      status: 'normalizing',
      created_by: user.id,
    })
    .select('id')
    .single();

  if (importErr || !importRow) {
    return err('IMPORT_INSERT_FAILED', importErr?.message ?? 'unknown', 500);
  }
  const importId = (importRow as { id: number }).id;

  // 4. Match each row against master products (cheap pass: SKU + barcode only)
  const { matchedRows, unmatchedRows } = await cheapMatch(admin, comparable);

  // 5. Bulk-insert platform_products
  let categoryMissingCount = 0;
  const productRows = comparable.map((n, i) => {
    const match = matchedRows.get(i);

    // Phase 13B: compute normalized + variant attributes from name_en (fallback name_ar).
    const sourceName = n.name_en ?? n.name_ar ?? '';
    const variantAttrs = extractVariantAttrs(sourceName);
    const normName = normalizeProductName(sourceName, variantAttrs.extracted_tokens);
    const normBrand = normalizeBrand(n.brand);

    // Phase 13B.15: category extraction (direct → brand → keyword → missing).
    // Pull category-hint header values (e.g. Snoonu's "Preparation Time(Update)")
    // into the description blob so keyword rules and future heuristics see them.
    const hintParts: string[] = [];
    for (const hintHeader of norm.category_hint_headers ?? []) {
      const v = n.raw?.[hintHeader];
      if (v !== null && v !== undefined && String(v).trim().length > 0) {
        hintParts.push(`${hintHeader}=${String(v).trim()}`);
      }
    }
    const descriptionBlob = [
      n.description_en,
      n.description_ar,
      hintParts.length > 0 ? hintParts.join('; ') : null,
    ]
      .filter(Boolean)
      .join(' | ');

    const cat = extractCategory({
      platform: norm.platform,
      raw_category: n.category,
      raw_subcategory: n.subcategory,
      product_name: n.name_en ?? n.name_ar,
      product_type: n.product_type,
      brand: n.brand,
      description: descriptionBlob || null,
    });
    if (cat.category_missing) categoryMissingCount++;

    // Pull image filename out of the URL if not provided directly
    let imageFilename = n.image_filename;
    if (!imageFilename && n.image_url) {
      try {
        const parts = new URL(n.image_url).pathname.split('/');
        imageFilename = parts[parts.length - 1] || null;
      } catch {
        // not a valid URL — leave null
      }
    }

    return {
      import_id: importId,
      platform: norm.platform,
      source_row_index: n.source_row_index,
      source_product_id: n.source_product_id,
      source_url: n.source_url,
      source_sku: n.source_sku,
      barcode: n.barcode,
      name_en: n.name_en,
      name_ar: n.name_ar,
      brand: n.brand,
      category: n.category,
      subcategory: n.subcategory,
      product_type: n.product_type,
      price: n.price,
      discount_price: n.discount_price,
      currency: n.currency,
      stock_quantity: n.stock_quantity,
      stock_status: n.stock_status,
      platform_status: n.platform_status,
      image_url: n.image_url,
      image_filename: imageFilename,
      description_en: n.description_en,
      description_ar: n.description_ar,
      variants: n.variants,

      // Phase 13B
      normalized_name: normName.normalized_name || null,
      normalized_brand: normBrand || null,
      name_root: normName.name_root || null,
      name_token_signature: normName.token_signature || null,
      variant_color: variantAttrs.variant_color,
      variant_shade: variantAttrs.variant_shade,
      variant_size: variantAttrs.variant_size,
      variant_volume_value: variantAttrs.variant_volume_value,
      variant_volume_unit: variantAttrs.variant_volume_unit,
      variant_pack: variantAttrs.variant_pack,
      variant_model: variantAttrs.variant_model,
      variant_type: variantAttrs.variant_type,

      // Phase 13B.14 — category fields
      raw_category: cat.raw_category,
      raw_subcategory: cat.raw_subcategory,
      category_name: cat.category_name,
      subcategory_name: cat.subcategory_name,
      category_confidence: cat.category_confidence,
      category_source: cat.category_source,
      category_missing: cat.category_missing,

      matched_master_sku: match?.master_sku ?? null,
      match_status: match ? 'exact' : 'pending',
      match_confidence: match?.confidence ?? null,
      match_signals: match?.signals ?? [],
      raw_payload: n.raw,
    };
  });

  // Insert in chunks of 1000 to stay under Supabase's payload limit
  let insertedTotal = 0;
  for (let i = 0; i < productRows.length; i += 1000) {
    const chunk = productRows.slice(i, i + 1000);
    const { error: insErr } = await admin.from('platform_products').insert(chunk);
    if (insErr) {
      await admin
        .from('platform_imports')
        .update({ status: 'error', error_message: insErr.message })
        .eq('id', importId);
      return err('PRODUCTS_INSERT_FAILED', insErr.message, 500, { inserted_so_far: insertedTotal });
    }
    insertedTotal += chunk.length;
  }

  // 6. Finalize the import row
  await admin
    .from('platform_imports')
    .update({
      parsed_rows: comparable.length,
      matched_rows: matchedRows.size,
      unmatched_rows: comparable.length - matchedRows.size,
      status: 'ready',
      completed_at: new Date().toISOString(),
    })
    .eq('id', importId);

  return ok({
    import_id: importId,
    platform: norm.platform,
    platform_score: norm.platform_score,
    total_rows: norm.rows.length,
    parsed_rows: comparable.length,
    skipped_rows: skipped,
    rows_without_key: noKey,
    matched_rows: matchedRows.size,
    unmatched_rows: comparable.length - matchedRows.size,
    category_missing_count: categoryMissingCount,
    category_column_mapped_from: norm.column_mapping['category'] ?? null,
    subcategory_column_mapped_from: norm.column_mapping['subcategory'] ?? null,
    column_mapping: norm.column_mapping,
    prefix_mapping: norm.prefix_mapping,
    category_hint_headers: norm.category_hint_headers,
    unmapped_headers: norm.unmapped_headers,
    detected_headers: norm.detected_headers,
    sample_rows: comparable.slice(0, 3).map((r) => ({
      sku: r.source_sku,
      barcode: r.barcode,
      name_en: r.name_en,
      name_ar: r.name_ar,
      price: r.price,
      brand: r.brand,
      raw_category: r.category,
    })),
    status: 'ready',
  });
});

// ─── Cheap match: SKU + barcode against master products ────────────────────

async function cheapMatch(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  rows: NormalizedProductRow[],
): Promise<{
  matchedRows: Map<number, { master_sku: string; confidence: number; signals: string[] }>;
  unmatchedRows: number[];
}> {
  const matched = new Map<number, { master_sku: string; confidence: number; signals: string[] }>();
  const unmatched: number[] = [];

  // Collect candidate SKUs and barcodes for a single bulk query
  const skuMap = new Map<string, number[]>();      // sku → row indices
  const barcodeMap = new Map<string, number[]>();  // barcode → row indices

  rows.forEach((r, i) => {
    if (r.source_sku) {
      const key = r.source_sku.toUpperCase().trim();
      if (!skuMap.has(key)) skuMap.set(key, []);
      skuMap.get(key)!.push(i);
    }
    if (r.barcode) {
      const key = r.barcode.trim();
      if (!barcodeMap.has(key)) barcodeMap.set(key, []);
      barcodeMap.get(key)!.push(i);
    }
  });

  // Bulk SKU lookup against products.master_sku, products.snoonu_sku, products.detailed_sku
  if (skuMap.size > 0) {
    const skus = [...skuMap.keys()];
    // Split into chunks of 500 to keep .in() payload reasonable
    for (let i = 0; i < skus.length; i += 500) {
      const chunk = skus.slice(i, i + 500);
      const { data } = await admin
        .from('products')
        .select('master_sku, snoonu_sku, detailed_sku')
        .or(
          `master_sku.in.(${chunk.map(q).join(',')}),snoonu_sku.in.(${chunk.map(q).join(',')}),detailed_sku.in.(${chunk.map(q).join(',')})`,
        );
      for (const r of data ?? []) {
        const row = r as { master_sku: string; snoonu_sku: string | null; detailed_sku: string | null };
        for (const candidateKey of [row.master_sku, row.snoonu_sku, row.detailed_sku]) {
          if (!candidateKey) continue;
          const upper = candidateKey.toUpperCase();
          const targetIndices = skuMap.get(upper);
          if (!targetIndices) continue;
          for (const idx of targetIndices) {
            if (!matched.has(idx)) {
              matched.set(idx, { master_sku: row.master_sku, confidence: 1.0, signals: ['sku_exact'] });
            }
          }
        }
      }
    }
  }

  // Bulk barcode lookup
  if (barcodeMap.size > 0) {
    const barcodes = [...barcodeMap.keys()];
    for (let i = 0; i < barcodes.length; i += 500) {
      const chunk = barcodes.slice(i, i + 500);
      const { data } = await admin
        .from('products')
        .select('master_sku, barcode')
        .in('barcode', chunk);
      for (const r of data ?? []) {
        const row = r as { master_sku: string; barcode: string };
        const targetIndices = barcodeMap.get(row.barcode);
        if (!targetIndices) continue;
        for (const idx of targetIndices) {
          if (!matched.has(idx)) {
            matched.set(idx, { master_sku: row.master_sku, confidence: 0.98, signals: ['barcode_exact'] });
          } else {
            // Promote: barcode confirms SKU
            const existing = matched.get(idx)!;
            if (existing.master_sku === row.master_sku) {
              existing.signals.push('barcode_exact');
            }
          }
        }
      }
    }
  }

  rows.forEach((_, i) => {
    if (!matched.has(i)) unmatched.push(i);
  });

  return { matchedRows: matched, unmatchedRows: unmatched };
}

/** Safely quote a value for a Supabase OR/.in() filter list. */
function q(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}
