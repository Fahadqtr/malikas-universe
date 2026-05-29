/**
 * GET /api/snoonu-fast-sync/debug-counts
 *
 * Counts platform_products rows by various filters to verify the section
 * scrape applies actually landed.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const admin = createAdminSupabaseClient();
  async function count(q: () => ReturnType<typeof admin.from>) {
    const { count: c } = await q().select('id', { count: 'exact', head: true });
    return c ?? 0;
  }
  const [total, withSpi, withCategory, viaSectionPage, viaBrowserAudit, withSecondary, primaryAndSecondary] = await Promise.all([
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').then(r => r.count ?? 0),
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').not('snoonu_spi', 'is', null).then(r => r.count ?? 0),
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').not('snoonu_category', 'is', null).then(r => r.count ?? 0),
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').eq('catalog_source', 'catalog_section_page').then(r => r.count ?? 0),
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').eq('catalog_source', 'browser_read').then(r => r.count ?? 0),
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').not('snoonu_secondary_categories', 'is', null).then(r => r.count ?? 0),
    admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').not('snoonu_category', 'is', null).not('snoonu_secondary_categories', 'is', null).then(r => r.count ?? 0),
  ]);

  // Per-section counts
  const sections = ['Hair Care','Face Care','Sun Protection','Masks','Body Care','Dental Care','Beauty Accessories','Beauty Bundle','Makeup','Lashes & Nails','Electronics','Rhode Products Section','Gifts & Special Occasions','Thailand Products','Toys',"Women's Essentials",'Eid Specials','Labubu Collection','Summer And Camping Supplies'];
  const perSection = await Promise.all(sections.map(async s => {
    const { count: c } = await admin.from('platform_products').select('id', { count: 'exact', head: true }).eq('platform', 'snoonu').eq('snoonu_category', s);
    return { section: s, primary_count: c ?? 0 };
  }));

  return ok({
    total_snoonu: total,
    with_snoonu_spi: withSpi,
    with_snoonu_category: withCategory,
    catalog_source_section_page: viaSectionPage,
    catalog_source_browser_audit: viaBrowserAudit,
    with_secondary_categories: withSecondary,
    primary_AND_secondary: primaryAndSecondary,
    per_section: perSection.filter(p => p.primary_count > 0),
  });
});
