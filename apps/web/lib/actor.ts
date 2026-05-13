/**
 * Resolves the authenticated actor for the current request.
 * Used by every API route before invoking services.
 */
import type { Actor } from '@/lib/services';
import { ServiceError } from '@/lib/services';
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server';

export async function getActor(): Promise<Actor> {
  const userClient = createServerSupabaseClient();
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) throw new ServiceError('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();
  const { data: profile, error: profileErr } = await admin
    .from('user_profiles')
    .select('id, email, role, is_active')
    .eq('id', user.id)
    .single();

  if (profileErr || !profile) throw new ServiceError('NO_PROFILE', 'User profile missing', 403);
  if (!profile.is_active) throw new ServiceError('INACTIVE', 'User deactivated', 403);

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role as Actor['role'],
  };
}
