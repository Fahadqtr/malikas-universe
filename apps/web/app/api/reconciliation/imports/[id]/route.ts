/**
 * GET /api/reconciliation/imports/[id]
 *
 * Inspector for a single import — returns:
 *   - the import row (platform, status, counts, column_mapping)
 *   - the first 10 normalized rows so the operator can verify mapping worked
 *   - histogram of fields that ARE populated (name_en, sku, barcode, price, image_url)
 *     so they can spot which canonical fields ended up empty
 *
 * Used by the diagnostic accordion on /reconciliation.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

const CANONICAL_FIELDS = [
  'source_sku',
  'barcode',
  'name_en',
  'name_ar',
  'brand',
  'category',
  'price',
  'discount_price',
  'stock_quantity',
  'image_url',
] as const;

export const GET = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return err('BAD_ID', 'Invalid import id', 400);

  const admin = createAdminSupabaseClient();

  const { data: importRow } = await admin
    .from('platform_imports')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!importRow) return err('IMPORT_NOT_FOUND', `Import ${id} not found`, 404);

  // First 10 product rows
  const { data: rows } = await admin
    .from('platform_products')
    .select(
      `id, source_row_index, source_sku, barcode, name_en, name_ar, brand,
       category, raw_category, raw_subcategory, category_name, subcategory_name,
       category_confidence, category_source, category_missing,
       price, discount_price, stock_quantity, image_url,
       matched_master_sku, match_status, match_confidence, raw_payload`,
    )
    .eq('import_id', id)
    .order('id', { ascending: true })
    .limit(10);

  // Field-population histogram across the whole import (sample up to 500 rows)
  const { data: sampleRows } = await admin
    .from('platform_products')
    .select(
      `source_sku, barcode, name_en, name_ar, brand, category, price,
       discount_price, stock_quantity, image_url,
       category_name, category_source, category_missing, raw_category`,
    )
    .eq('import_id', id)
    .limit(500);

  const populated: Record<string, number> = {};
  for (const field of CANONICAL_FIELDS) populated[field] = 0;
  for (const r of sampleRows ?? []) {
    const row = r as Record<string, unknown>;
    for (const field of CANONICAL_FIELDS) {
      const v = row[field];
      if (v !== null && v !== undefined && v !== '') populated[field] = populated[field]! + 1;
    }
  }
  const sampleSize = sampleRows?.length ?? 0;

  // ─── Phase 13B.17: Category-specific diagnostics ────────────────────────
  const colMap = (importRow.column_mapping as Record<string, string> | null) ?? {};

  // Top-N category counts (use the canonical category_name)
  const catCounts = new Map<string, number>();
  const sourceCounts: Record<string, number> = { direct_column: 0, inferred_rule: 0, inferred_ai: 0, manual: 0 };
  let categoryMissing = 0;
  let categoryPopulated = 0;

  for (const r of sampleRows ?? []) {
    const row = r as { category_name: string | null; category_source: string | null; category_missing: boolean };
    if (row.category_missing) categoryMissing++;
    if (row.category_name) {
      categoryPopulated++;
      catCounts.set(row.category_name, (catCounts.get(row.category_name) ?? 0) + 1);
    }
    if (row.category_source && row.category_source in sourceCounts) {
      sourceCounts[row.category_source] = sourceCounts[row.category_source]! + 1;
    }
  }

  const topCategories = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  return ok({
    import: importRow,
    sample_size: sampleSize,
    field_population: Object.fromEntries(
      CANONICAL_FIELDS.map((f) => [f, { populated: populated[f]!, pct: sampleSize > 0 ? populated[f]! / sampleSize : 0 }]),
    ),
    category_diagnostics: {
      category_column_mapped_from: colMap.category ?? null,
      subcategory_column_mapped_from: colMap.subcategory ?? null,
      sample_size: sampleSize,
      category_populated: categoryPopulated,
      category_population_pct: sampleSize > 0 ? categoryPopulated / sampleSize : 0,
      category_missing_count: categoryMissing,
      source_breakdown: sourceCounts,
      top_categories: topCategories,
    },
    rows: rows ?? [],
  });
});
