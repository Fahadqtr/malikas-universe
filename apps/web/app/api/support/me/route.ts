/**
 * GET /api/support/me — returns the current actor's support_agent profile.
 * Used by the dashboard to track presence and "assigned to me" filter.
 */
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const actor = await getActor();
  const admin = createAdminSupabaseClient();

  const { data } = await admin
    .from('support_agents')
    .select('id, email, display_name, role, avatar_url')
    .eq('email', actor.email)
    .maybeSingle();

  return ok({
    actor: { email: actor.email, role: actor.role },
    agent: data ?? null,
  });
});
