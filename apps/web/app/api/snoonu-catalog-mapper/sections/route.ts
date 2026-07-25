/**
 * GET /api/snoonu-catalog-mapper/sections
 *
 * List every Snoonu catalog section we've captured.
 *
 * Query params:
 *   ?source_url=…   filter to one source page
 *   ?limit=200
 *
 * DELETE /api/snoonu-catalog-mapper/sections?id=N
 *   Remove a single section (operator cleanup).
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const sourceUrl = url.searchParams.get('source_url');
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));

  const admin = createAdminSupabaseClient();
  let q = admin
    .from('snoonu_catalog_sections')
    .select('id, catalog_name_en, catalog_name_ar, product_count, source_url, scraped_at, raw_text, notes')
    .order('catalog_name_en', { ascending: true })
    .limit(limit);
  if (sourceUrl) q = q.eq('source_url', sourceUrl);

  const { data } = await q;
  return ok({ sections: data ?? [] });
});

export const DELETE = withErrorHandling(async (req: NextRequest) => {
  // Owner-only gate FIRST — before reading searchParams, admin client, or delete.
  await requireActor(ROLE_SETS.ownerOnly);

  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return err('BAD_ID', 'Pass ?id=N', 400);
  }
  const admin = createAdminSupabaseClient();
  const { error } = await admin.from('snoonu_catalog_sections').delete().eq('id', id);
  if (error) {
    console.error(`[catalog-mapper/sections] delete failed (id=${id})`, error);
    return err('DELETE_FAILED', 'Internal server error', 500);
  }
  return ok({ deleted: id });
});
