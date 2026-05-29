/**
 * GET /api/reconciliation/imports/[id]/rows
 *
 * Paginated row list for the import preview page.
 *
 * Query params:
 *   ?missing=true       — only category-missing rows
 *   ?category=Korean    — filter by category_name
 *   ?source=direct_column|inferred_rule|manual
 *   ?q=foo              — substring match on name_en/source_sku
 *   ?page=1&limit=50
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export const GET = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const importId = Number(params.id);
  if (!Number.isInteger(importId) || importId <= 0) {
    return err('BAD_ID', 'Invalid import id', 400);
  }

  const url = new URL(req.url);
  const missing = url.searchParams.get('missing') === 'true';
  const category = url.searchParams.get('category');
  const source = url.searchParams.get('source');
  const q = url.searchParams.get('q');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = (page - 1) * limit;

  const admin = createAdminSupabaseClient();

  let qry = admin
    .from('platform_products')
    .select(
      `id, source_row_index, source_sku, barcode, name_en, name_ar, brand,
       raw_category, raw_subcategory, category_name, subcategory_name,
       category_confidence, category_source, category_missing,
       product_type, price, image_url, matched_master_sku, match_status`,
      { count: 'exact' },
    )
    .eq('import_id', importId);

  if (missing) qry = qry.eq('category_missing', true);
  if (category) qry = qry.eq('category_name', category);
  if (source) qry = qry.eq('category_source', source);
  if (q && q.trim()) {
    const term = q.trim();
    qry = qry.or(`name_en.ilike.%${term}%,name_ar.ilike.%${term}%,source_sku.ilike.%${term}%`);
  }

  qry = qry.order('id', { ascending: true }).range(offset, offset + limit - 1);

  const { data, count, error } = await qry;
  if (error) return err('QUERY_FAILED', error.message, 500);

  return ok({
    rows: data ?? [],
    page,
    limit,
    total: count ?? 0,
  });
});
