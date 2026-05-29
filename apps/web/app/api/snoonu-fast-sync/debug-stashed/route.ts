/**
 * GET /api/snoonu-fast-sync/debug-stashed
 *
 * Returns the most recent stashed scrape rows (status='running' with
 * section_name='__stashed_batch__') so we can confirm the keepalive POST
 * from the Snoonu portal tab actually landed.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('snoonu_section_scrapes')
    .select('id, section_name, status, products_found, started_at, raw_payload')
    .eq('section_name', '__stashed_batch__')
    .order('id', { ascending: false })
    .limit(5);
  if (error) return err('QUERY_FAILED', error.message, 500);

  return ok({
    rows: (data ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      products_found: r.products_found,
      started_at: r.started_at,
      sections_in_payload: Array.isArray((r.raw_payload as { sections?: unknown[] })?.sections)
        ? (r.raw_payload as { sections: unknown[] }).sections.length
        : 0,
      section_names: Array.isArray((r.raw_payload as { sections?: Array<{ section_name: string }> })?.sections)
        ? (r.raw_payload as { sections: Array<{ section_name: string }> }).sections.map((s) => s.section_name)
        : [],
    })),
  });
});
