/**
 * GET /api/reconciliation/imports
 *
 * List recent platform imports. Used by the upload zone to show what's
 * available for selection as baseline / target.
 *
 * ?platform=snoonu  — filter to one platform (default: all)
 * ?limit=20
 */

import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  const admin = createAdminSupabaseClient();
  let q = admin
    .from('platform_imports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (platform) q = q.eq('platform', platform);

  const { data } = await q;
  return ok({ imports: data ?? [] });
});
