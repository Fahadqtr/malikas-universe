/**
 * DELETE /api/reconciliation/runs/[id]/purge
 *
 * Hard-delete a reconciliation run and ALL its findings. Used to clean up
 * broken runs that have orphaned findings (no product_ids, no snapshots).
 *
 * Body: { confirm: 'PURGE_RUN_<id>' }
 *
 * The confirm string is a safety check — must match exactly the run id
 * being deleted. Prevents accidental purges via stale tabs.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export const DELETE = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const runId = Number(params.id);
  if (!Number.isInteger(runId) || runId <= 0) {
    return err('BAD_RUN_ID', 'Invalid run id', 400);
  }

  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  const expected = `PURGE_RUN_${runId}`;
  if (body.confirm !== expected) {
    return err(
      'CONFIRM_REQUIRED',
      `To purge this run, POST body must include { "confirm": "${expected}" }`,
      400,
    );
  }

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // Count first so we can return what we deleted
  const { count: findingsCount } = await admin
    .from('reconciliation_findings')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId);

  // ON DELETE CASCADE on the findings table will nuke them when the run is dropped,
  // but we delete findings explicitly so we can confirm the count.
  const { error: findErr } = await admin
    .from('reconciliation_findings')
    .delete()
    .eq('run_id', runId);
  if (findErr) return err('FINDINGS_DELETE_FAILED', findErr.message, 500);

  const { error: runErr } = await admin
    .from('reconciliation_runs')
    .delete()
    .eq('id', runId);
  if (runErr) return err('RUN_DELETE_FAILED', runErr.message, 500);

  return ok({
    run_id: runId,
    findings_deleted: findingsCount ?? 0,
  });
});

// Allow POST as an alias since the UI prefers POST for destructive actions.
export const POST = DELETE;
