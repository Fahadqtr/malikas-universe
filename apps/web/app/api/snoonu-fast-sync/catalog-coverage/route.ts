/**
 * GET /api/snoonu-fast-sync/catalog-coverage
 *
 * Phase 13F.5/6. Returns the overall Snoonu catalog mapping coverage
 * + last-scrape status per section. Drives the UI status grid.
 *
 *   {
 *     coverage: { total, with_category, missing, multi_category,
 *                 via_section_page, via_browser_audit, high_confidence, ... },
 *     sections: [{ section_name, products_found, products_matched,
 *                  products_unmatched, last_scraped_at, status }, ...]
 *   }
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const admin = createAdminSupabaseClient();

  const [coverageRes, sectionsRes] = await Promise.all([
    admin.from('v_snoonu_catalog_coverage').select('*').single(),
    admin.from('v_snoonu_section_coverage').select('*'),
  ]);

  if (coverageRes.error) return err('COVERAGE_FAILED', coverageRes.error.message, 500);
  if (sectionsRes.error) return err('SECTIONS_FAILED', sectionsRes.error.message, 500);

  return ok({
    coverage: coverageRes.data,
    sections: sectionsRes.data ?? [],
  });
});
