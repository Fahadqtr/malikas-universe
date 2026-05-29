/**
 * POST /api/support/notifications/read-all  — mark all notifications as read.
 */
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const POST = withErrorHandling(async (_req: NextRequest) => {
  await getActor();
  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('notification_events')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) throw new Error(error.message);
  return ok({ marked: true });
});
