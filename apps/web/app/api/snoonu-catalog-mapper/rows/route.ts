/**
 * GET /api/snoonu-catalog-mapper/rows
 *
 * Paginated list of Snoonu platform_products rows with their current catalog
 * mapping status. Used by the catalog mapper dashboard.
 *
 * Query params:
 *   ?import_id=        filter to one Snoonu import (optional — defaults to most recent)
 *   ?status=mapped | missing | needs_review
 *   ?source=export_column|manual_paste|browser_read|inferred
 *   ?q=                substring search on name_en / source_sku
 *   ?page=1&limit=50
 *
 * Status semantics:
 *   mapped         — snoonu_category IS NOT NULL AND catalog_confidence >= 0.85
 *   needs_review   — snoonu_category IS NOT NULL AND catalog_confidence  < 0.85
 *   missing        — snoonu_category IS NULL
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const importIdParam = url.searchParams.get('import_id');
  const status = url.searchParams.get('status');
  const source = url.searchParams.get('source');
  const q = url.searchParams.get('q');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = (page - 1) * limit;

  const admin = createAdminSupabaseClient();

  // Default to the most recent Snoonu import if none specified
  let importId: number | null = importIdParam ? Number(importIdParam) : null;
  if (!importId) {
    const { data: recent } = await admin
      .from('platform_imports')
      .select('id')
      .eq('platform', 'snoonu')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    importId = (recent as { id: number } | null)?.id ?? null;
  }
  if (!importId) {
    return ok({
      rows: [],
      page,
      limit,
      total: 0,
      summary: null,
      message: 'No Snoonu imports found — upload a Snoonu export first',
    });
  }

  // Build query
  let qry = admin
    .from('platform_products')
    .select(
      `id, source_sku, name_en, name_ar, brand, normalized_name, image_url,
       category_name, raw_category,
       snoonu_catalog, snoonu_category, snoonu_subcategory, snoonu_section,
       snoonu_collection, snoonu_menu_path, snoonu_catalog_source_url,
       catalog_source, catalog_confidence, catalog_checked_at`,
      { count: 'exact' },
    )
    .eq('platform', 'snoonu')
    .eq('import_id', importId);

  if (status === 'mapped') {
    qry = qry.not('snoonu_category', 'is', null).gte('catalog_confidence', 0.85);
  } else if (status === 'missing') {
    qry = qry.is('snoonu_category', null);
  } else if (status === 'needs_review') {
    qry = qry.not('snoonu_category', 'is', null).lt('catalog_confidence', 0.85);
  }
  if (source) qry = qry.eq('catalog_source', source);
  if (q && q.trim()) {
    const term = q.trim();
    qry = qry.or(`name_en.ilike.%${term}%,name_ar.ilike.%${term}%,source_sku.ilike.%${term}%`);
  }

  qry = qry.order('id', { ascending: true }).range(offset, offset + limit - 1);

  const { data, count, error } = await qry;
  if (error) return err('QUERY_FAILED', error.message, 500);

  // Summary counts for the dashboard header
  const { data: summary } = await admin
    .from('v_snoonu_catalog_mapping_summary')
    .select('*')
    .eq('import_id', importId)
    .maybeSingle();

  return ok({
    rows: data ?? [],
    page,
    limit,
    total: count ?? 0,
    import_id: importId,
    summary: summary ?? null,
  });
});
