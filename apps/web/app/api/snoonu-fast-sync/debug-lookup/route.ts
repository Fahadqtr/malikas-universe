/**
 * GET /api/snoonu-fast-sync/debug-lookup?q=<term>
 *
 * Debug-only. Returns full platform_products rows whose name_en or
 * normalized_name matches the query, plus a sample of the snoonu_spi
 * format so we can compare against what's visible in Snoonu's portal DOM.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  if (!q) return err('NEED_Q', 'Pass ?q=<term>', 400);

  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from('platform_products')
    .select(
      `id, platform, snoonu_spi, source_product_id, source_sku, barcode,
       name_en, name_ar, normalized_name, price, snoonu_category, snoonu_secondary_categories,
       catalog_source, catalog_confidence, snoonu_export_synced_at, import_id`,
    )
    .eq('platform', 'snoonu')
    .or(`name_en.ilike.%${q}%,normalized_name.ilike.%${q}%`)
    .limit(15);

  if (error) return err('QUERY_FAILED', error.message, 500);

  // Also overall stats
  const { count: total } = await admin
    .from('platform_products')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'snoonu');
  const { count: withSpi } = await admin
    .from('platform_products')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'snoonu')
    .not('snoonu_spi', 'is', null);
  const { count: withSourceProductId } = await admin
    .from('platform_products')
    .select('id', { count: 'exact', head: true })
    .eq('platform', 'snoonu')
    .not('source_product_id', 'is', null);

  return ok({
    matches: data ?? [],
    stats: {
      total_snoonu_rows: total ?? 0,
      with_snoonu_spi: withSpi ?? 0,
      with_source_product_id: withSourceProductId ?? 0,
    },
  });
});
