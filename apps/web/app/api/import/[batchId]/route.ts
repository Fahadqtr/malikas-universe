/**
 * GET /api/import/[batchId]
 * Returns batch status + staged rows for review UI.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const GET = withErrorHandling(
  async (req: NextRequest, ctx: { params: { batchId: string } }) => {
    const batchId = parseInt(ctx.params.batchId, 10);
    if (!Number.isFinite(batchId)) return err('BAD_ID', 'Invalid batch id', 400);

    const admin = createAdminSupabaseClient();

    const [batchRes, rowsRes] = await Promise.all([
      admin.from('import_batches').select('*').eq('id', batchId).single(),
      admin.from('import_errors').select('*').eq('batch_id', batchId).order('row_number'),
    ]);

    if (batchRes.error || !batchRes.data) return err('NOT_FOUND', 'Batch not found', 404);

    return ok({
      batch: batchRes.data,
      rows: rowsRes.data ?? [],
    });
  },
);
