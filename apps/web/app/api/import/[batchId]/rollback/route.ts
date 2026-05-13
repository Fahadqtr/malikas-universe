/**
 * POST /api/import/[batchId]/rollback
 * Soft-deletes every product created by this batch.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const POST = withErrorHandling(
  async (_req: NextRequest, ctx: { params: { batchId: string } }) => {
    const batchId = parseInt(ctx.params.batchId, 10);
    if (!Number.isFinite(batchId)) return err('BAD_ID', 'Invalid batch id', 400);

    const admin = createAdminSupabaseClient();
    const tag = `import_batch:${batchId}`;

    const { data, error } = await admin
      .from('products')
      .update({
        deleted_at: new Date().toISOString(),
        product_status: 'archived',
        updated_by: `rollback:${batchId}`,
      })
      .eq('created_by', tag)
      .is('deleted_at', null)
      .select('master_sku');

    if (error) return err('DB_ERROR', error.message, 500);

    await admin
      .from('import_batches')
      .update({ status: 'rolled_back' })
      .eq('id', batchId);

    return ok({ batch_id: batchId, rolled_back_count: data?.length ?? 0 });
  },
);
