/**
 * Resolves the authenticated actor for the current request.
 * Used by every API route (via `requireActor`) before invoking services.
 *
 * Ordered, fail-closed gate:
 *   1. Verify the session with the USER client (no admin client is created if
 *      auth fails).
 *   2. Load the profile with the admin client.
 *   3. Reject a missing profile (403) and an inactive account (403).
 *   4. Runtime-validate the role via `isAppRole` (no unchecked cast) — an
 *      invalid/unknown DB role fails closed with 403.
 */
import type { Actor } from '@/lib/authz/types';
import { ServiceError } from '@/lib/authz/errors';
import { isAppRole } from '@/lib/authz/roles';
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server';

export async function getActor(): Promise<Actor> {
  // 1. Session check with the user client FIRST — do not build the admin client
  //    (service-role) until we know there is a real authenticated user.
  const userClient = createServerSupabaseClient();
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) throw new ServiceError('UNAUTHORIZED', 'Login required', 401);

  // 2. Load the profile with the admin client (only reached after auth success).
  const admin = createAdminSupabaseClient();
  const { data: profile, error: profileErr } = await admin
    .from('user_profiles')
    .select('id, email, role, is_active')
    .eq('id', user.id)
    .single();

  // 3. Reject missing profile / inactive account. profileErr is logged only as a
  //    generic 403 by the caller — never surface raw DB error text to clients.
  if (profileErr || !profile) throw new ServiceError('NO_PROFILE', 'User profile missing', 403);
  if (!profile.is_active) throw new ServiceError('INACTIVE', 'User deactivated', 403);

  // 4. Validate the role at runtime instead of an unchecked `as` cast.
  if (!isAppRole(profile.role)) {
    throw new ServiceError('INVALID_ROLE', 'User role is invalid', 403);
  }

  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
  };
}
