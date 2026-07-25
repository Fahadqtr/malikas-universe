/**
 * GET /api/snoonu-catalog-mapper/export?import_id=N&format=csv
 *
 * Returns a downloadable CSV of every Snoonu product with its current catalog
 * mapping. Used as the audit report you can hand to the operations team.
 */

import { NextRequest, NextResponse } from 'next/server';
import { err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const HEADERS = [
  'sku',
  'name_en',
  'name_ar',
  'brand',
  'category_detected',
  'snoonu_catalog',
  'snoonu_category',
  'snoonu_subcategory',
  'snoonu_section',
  'snoonu_collection',
  'snoonu_menu_path',
  'snoonu_catalog_source_url',
  'catalog_source',
  'catalog_confidence',
  'catalog_checked_at',
];

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const importId = Number(url.searchParams.get('import_id'));
  if (!Number.isInteger(importId) || importId <= 0) {
    return err('BAD_IMPORT_ID', 'Pass ?import_id=N', 400);
  }

  const admin = createAdminSupabaseClient();
  const { data: rows } = await admin
    .from('platform_products')
    .select(
      `source_sku, name_en, name_ar, brand, category_name,
       snoonu_catalog, snoonu_category, snoonu_subcategory, snoonu_section,
       snoonu_collection, snoonu_menu_path, snoonu_catalog_source_url,
       catalog_source, catalog_confidence, catalog_checked_at`,
    )
    .eq('platform', 'snoonu')
    .eq('import_id', importId)
    .order('id', { ascending: true });

  const lines = [HEADERS.join(',')];
  for (const r of rows ?? []) {
    const row = r as Record<string, unknown>;
    lines.push(
      [
        row.source_sku,
        row.name_en,
        row.name_ar,
        row.brand,
        row.category_name,
        row.snoonu_catalog,
        row.snoonu_category,
        row.snoonu_subcategory,
        row.snoonu_section,
        row.snoonu_collection,
        row.snoonu_menu_path,
        row.snoonu_catalog_source_url,
        row.catalog_source,
        row.catalog_confidence,
        row.catalog_checked_at,
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  const csv = lines.join('\n');
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="snoonu-catalog-mapping-import-${importId}.csv"`,
    },
  });
});
