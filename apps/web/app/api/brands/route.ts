/**
 * GET /api/brands — list all active brands
 */
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const GET = withErrorHandling(async () => {
  await getActor(); // auth check
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('brands')
    .select('id, name, name_ar, code, country_origin')
    .eq('is_active', true)
    .order('name');
  if (error) return err('DB_ERROR', error.message, 500);
  return ok(data ?? []);
});
