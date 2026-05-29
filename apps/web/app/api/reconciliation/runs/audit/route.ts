/**
 * GET /api/reconciliation/runs/audit
 *
 * Scans every recent run and reports which ones are broken:
 *   - findings with no product_ids
 *   - findings with no snapshots
 *   - findings where joined platform_products rows are gone
 *
 * Use this to identify which runs to purge.
 *
 * Returns:
 *   {
 *     runs: [{
 *       id, label, status, created_at,
 *       findings_total,
 *       findings_with_no_product_ids,
 *       findings_with_no_snapshots,
 *       findings_with_orphan_baseline,
 *       findings_with_orphan_target,
 *       health: 'ok' | 'degraded' | 'broken'
 *     }]
 *   }
 */

import { ok, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = withErrorHandling(async () => {
  const admin = createAdminSupabaseClient();

  const { data: runs } = await admin
    .from('reconciliation_runs')
    .select('id, label, status, created_at, findings_total')
    .order('created_at', { ascending: false })
    .limit(50);

  if (!runs || runs.length === 0) {
    return ok({ runs: [] });
  }

  const audited = await Promise.all(
    (runs as Array<{
      id: number;
      label: string | null;
      status: string;
      created_at: string;
      findings_total: number;
    }>).map(async (r) => {
      // Pull a representative sample (up to 1000) to compute health
      const { data: findings } = await admin
        .from('reconciliation_findings')
        .select(
          `id, baseline_product_id, target_product_id, baseline_snapshot, target_snapshot,
           baseline:platform_products!baseline_product_id (id),
           target:platform_products!target_product_id (id)`,
        )
        .eq('run_id', r.id)
        .limit(1000);

      const fs = (findings ?? []) as Array<{
        id: number;
        baseline_product_id: number | null;
        target_product_id: number | null;
        baseline_snapshot: Record<string, unknown> | null;
        target_snapshot: Record<string, unknown> | null;
        baseline: { id: number } | null;
        target: { id: number } | null;
      }>;

      let noProductIds = 0;
      let noSnapshots = 0;
      let orphanBaseline = 0;
      let orphanTarget = 0;

      for (const f of fs) {
        if (f.baseline_product_id == null && f.target_product_id == null) noProductIds++;
        if (!snapPopulated(f.baseline_snapshot) && !snapPopulated(f.target_snapshot)) noSnapshots++;
        if (f.baseline_product_id != null && f.baseline == null) orphanBaseline++;
        if (f.target_product_id != null && f.target == null) orphanTarget++;
      }

      const sampleSize = fs.length;
      let health: 'ok' | 'degraded' | 'broken' = 'ok';
      if (noProductIds > 0 || noSnapshots > sampleSize * 0.5) health = 'broken';
      else if (orphanBaseline > 0 || orphanTarget > 0 || noSnapshots > 0) health = 'degraded';

      return {
        ...r,
        sample_size: sampleSize,
        findings_with_no_product_ids: noProductIds,
        findings_with_no_snapshots: noSnapshots,
        findings_with_orphan_baseline: orphanBaseline,
        findings_with_orphan_target: orphanTarget,
        health,
      };
    }),
  );

  return ok({
    runs: audited,
    summary: {
      total: audited.length,
      ok: audited.filter((r) => r.health === 'ok').length,
      degraded: audited.filter((r) => r.health === 'degraded').length,
      broken: audited.filter((r) => r.health === 'broken').length,
    },
  });
});

function snapPopulated(s: Record<string, unknown> | null | undefined): boolean {
  if (!s || typeof s !== 'object') return false;
  return Boolean(
    s.name_en || s.name_ar || s.normalized_name || s.source_sku ||
    s.matched_master_sku || s.barcode,
  );
}
