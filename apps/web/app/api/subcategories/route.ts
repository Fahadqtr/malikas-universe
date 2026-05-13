/**
 * GET /api/subcategories?category_id=X
 * If category_id is omitted, returns all subcategories.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const GET = withErrorHandling(async (req: NextRequest) => {
  await getActor();
  const admin = createAdminSupabaseClient();

  const categoryId = req.nextUrl.searchParams.get('category_id');
  let query = admin
    .from('subcategories')
    .select('id, category_id, name, name_ar')
    .eq('is_active', true)
    .order('display_order');

  if (categoryId) query = query.eq('category_id', Number(categoryId));

  const { data, error } = await query;
  if (error) return err('DB_ERROR', error.message, 500);
  return ok(data ?? []);
});
