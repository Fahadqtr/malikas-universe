/**
 * GET /api/export/history?target=&limit=&offset=
 *
 * Returns past exports. Used by /export-center sidebar.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const Query = z.object({
  target: z.enum(['snoonu', 'talabat', 'rafeeq', 'shopify', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  // Owner/editor gate FIRST — before query parse, admin client, or DB.
  await requireActor(ROLE_SETS.writers);

  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = Query.parse(params);
  const admin = createAdminSupabaseClient();

  // Explicit safe column allowlist — never select `exported_by` (staff email).
  let query = admin
    .from('export_history')
    .select(
      'id, target, format, filters, product_count, blocked_count, file_bytes, filename, exported_at, notes',
      { count: 'exact' },
    )
    .order('exported_at', { ascending: false });

  if (q.target !== 'all') query = query.eq('target', q.target);
  query = query.range(q.offset, q.offset + q.limit - 1);

  const { data, count, error } = await query;
  if (error) {
    console.error('[export/history] history query failed', error);
    return err('HISTORY_FAILED', 'Export history failed', 500);
  }

  // Serialization allowlist — guarantees no staff email leaks even if the row
  // unexpectedly carries `exported_by`.
  const items = (data ?? []).map((row) => ({
    id: row.id,
    target: row.target,
    format: row.format,
    filters: row.filters,
    product_count: row.product_count,
    blocked_count: row.blocked_count,
    file_bytes: row.file_bytes,
    filename: row.filename,
    exported_at: row.exported_at,
    notes: row.notes,
  }));

  return ok({
    items,
    total: count ?? 0,
    limit: q.limit,
    offset: q.offset,
  });
});
