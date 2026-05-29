/**
 * GET /api/support/notifications?limit=&kind=
 *
 * Returns notification_events history for the drawer.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  kind: z.string().optional(),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  await getActor();
  const q = Query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const admin = createAdminSupabaseClient();

  let query = admin
    .from('notification_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(q.limit);
  if (q.kind) query = query.eq('kind', q.kind);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return ok({ items: data ?? [] });
});
