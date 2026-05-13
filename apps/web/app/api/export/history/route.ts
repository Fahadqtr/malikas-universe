/**
 * GET /api/export/history?target=&limit=&offset=
 *
 * Returns past exports. Used by /export-center sidebar.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const Query = z.object({
  target: z.enum(['snoonu', 'talabat', 'rafeeq', 'shopify', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  await getActor();

  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = Query.parse(params);
  const admin = createAdminSupabaseClient();

  let query = admin
    .from('export_history')
    .select('*', { count: 'exact' })
    .order('exported_at', { ascending: false });

  if (q.target !== 'all') query = query.eq('target', q.target);
  query = query.range(q.offset, q.offset + q.limit - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(error.message);

  return ok({
    items: data ?? [],
    total: count ?? 0,
    limit: q.limit,
    offset: q.offset,
  });
});
