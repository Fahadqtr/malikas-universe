/**
 * GET /api/support/agents — list active support agents (for assignment dropdown)
 */
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  await getActor();
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('support_agents')
    .select('id, email, display_name, role, languages, avatar_url')
    .eq('is_active', true)
    .order('display_name');
  if (error) throw new Error(error.message);
  return ok({ items: data ?? [] });
});
