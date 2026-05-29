/**
 * GET /api/reconciliation/runs/[id]
 *
 * Return run summary + findings breakdown by type + severity.
 * Used by the /reconciliation/[runId] dashboard.
 *
 * Response:
 *   {
 *     run: { id, label, baseline_platform, target_platforms, status, ... },
 *     summary: {
 *       baseline_total, target_totals, findings_total,
 *       by_type:     { price_mismatch: 12, ... },
 *       by_severity: { critical: 3, high: 7, ... },
 *       by_platform: { talabat: { ... }, rafeeq: { ... } }
 *     }
 *   }
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export const GET = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const runId = Number(params.id);
  if (!Number.isInteger(runId) || runId <= 0) return err('BAD_RUN_ID', 'Invalid run id', 400);

  const admin = createAdminSupabaseClient();

  const { data: run } = await admin
    .from('reconciliation_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();

  if (!run) return err('RUN_NOT_FOUND', `Run ${runId} not found`, 404);

  const { data: findings } = await admin
    .from('reconciliation_findings')
    .select('finding_type, severity, target_platform, resolution_status')
    .eq('run_id', runId);

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byPlatform: Record<string, Record<string, number>> = {};

  for (const f of findings ?? []) {
    const row = f as { finding_type: string; severity: string; target_platform: string; resolution_status: string };
    byType[row.finding_type] = (byType[row.finding_type] ?? 0) + 1;
    bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + 1;
    if (!byPlatform[row.target_platform]) byPlatform[row.target_platform] = {};
    byPlatform[row.target_platform][row.finding_type] =
      (byPlatform[row.target_platform][row.finding_type] ?? 0) + 1;
  }

  return ok({
    run,
    summary: {
      findings_total: findings?.length ?? 0,
      by_type: byType,
      by_severity: bySeverity,
      by_platform: byPlatform,
    },
  });
});
