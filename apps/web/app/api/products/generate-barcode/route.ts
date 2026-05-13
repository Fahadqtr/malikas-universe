/**
 * POST /api/products/generate-barcode
 * Returns a new internal EAN-13 barcode (Qatar prefix 629).
 * Use only when manufacturer barcode is unavailable.
 */
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const POST = withErrorHandling(async () => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot generate barcodes`, 403);
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc('generate_internal_barcode');
  if (error) return err('RPC_ERROR', error.message, 500);

  return ok({ barcode: data as unknown as string });
});
