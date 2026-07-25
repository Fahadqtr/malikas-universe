/**
 * POST /api/reconciliation/runs/[id]/repair-snapshots
 *
 * Backfill baseline_snapshot / target_snapshot on every finding in this run
 * that's currently NULL or empty.
 *
 * Strategy:
 *   1. Page through all findings for the run that lack a populated snapshot
 *      on at least one side AND still have a baseline_product_id or
 *      target_product_id pointing at a live platform_products row.
 *   2. For each, read the joined product row, project a snapshot, and
 *      update the finding.
 *
 * Returns: { run_id, scanned, repaired, still_missing }
 *
 * `still_missing` are findings where the product_id is null on the side that
 * has no snapshot — i.e. the comparator marked the side as truly missing
 * (e.g. missing_on_target → target_snapshot is correctly NULL forever).
 */

import { NextRequest } from 'next/server';
import type { Database } from '@malikas/db';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 180;

type RouteContext = { params: { id: string } };

const SNAPSHOT_FIELDS = `
  id, platform, source_sku, name_en, name_ar, normalized_name, barcode,
  matched_master_sku, price, stock_quantity, image_url, image_filename,
  brand, category, category_name, subcategory_name,
  variant_color, variant_size, variant_pack
`;

export const POST = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const runId = Number(params.id);
  if (!Number.isInteger(runId) || runId <= 0) {
    return err('BAD_RUN_ID', 'Invalid run id', 400);
  }

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  let scanned = 0;
  let alreadyComplete = 0;
  let baselineRepaired = 0;
  let targetRepaired = 0;
  let bothRepaired = 0;
  let byDesignBaselineNull = 0;     // missing_on_baseline findings — baseline is null by design
  let byDesignTargetNull = 0;       // missing_on_target findings — target is null by design
  let trulyOrphaned = 0;            // product_id set but joined row gone (FK SET NULL after deletion)

  let offset = 0;
  const pageSize = 500;

  while (true) {
    const { data: findings, error: selErr } = await admin
      .from('reconciliation_findings')
      .select(
        `id, finding_type, baseline_product_id, target_product_id,
         baseline_snapshot, target_snapshot,
         baseline:platform_products!baseline_product_id (${SNAPSHOT_FIELDS}),
         target:platform_products!target_product_id (${SNAPSHOT_FIELDS})`,
      )
      .eq('run_id', runId)
      .range(offset, offset + pageSize - 1);

    if (selErr) return err('SELECT_FAILED', selErr.message, 500);
    if (!findings || findings.length === 0) break;

    for (const raw of findings) {
      scanned++;
      const f = raw as unknown as {
        id: number;
        finding_type: string;
        baseline_product_id: number | null;
        target_product_id: number | null;
        baseline_snapshot: Record<string, unknown> | null;
        target_snapshot: Record<string, unknown> | null;
        baseline: Record<string, unknown> | null;
        target: Record<string, unknown> | null;
      };

      const baselinePopulated = isPopulated(f.baseline_snapshot);
      const targetPopulated = isPopulated(f.target_snapshot);

      if (baselinePopulated && targetPopulated) {
        alreadyComplete++;
        continue;
      }

      const update: Record<string, unknown> = {};
      let didBaseline = false;
      let didTarget = false;

      // ─── Baseline side ───
      if (!baselinePopulated) {
        if (f.baseline) {
          update.baseline_snapshot = projectSnapshot(f.baseline);
          didBaseline = true;
        } else if (f.baseline_product_id == null) {
          // No FK set → finding intentionally has no baseline (missing_on_baseline)
          byDesignBaselineNull++;
        } else {
          // FK was set but joined row not returned → orphaned product
          trulyOrphaned++;
        }
      }

      // ─── Target side ───
      if (!targetPopulated) {
        if (f.target) {
          update.target_snapshot = projectSnapshot(f.target);
          didTarget = true;
        } else if (f.target_product_id == null) {
          byDesignTargetNull++;
        } else {
          trulyOrphaned++;
        }
      }

      if (didBaseline || didTarget) {
        const { error: updErr } = await admin
          .from('reconciliation_findings')
          .update(update as Database['public']['Tables']['reconciliation_findings']['Update'])
          .eq('id', f.id);
        if (!updErr) {
          if (didBaseline && didTarget) bothRepaired++;
          else if (didBaseline) baselineRepaired++;
          else if (didTarget) targetRepaired++;
        }
      }
    }

    if (findings.length < pageSize) break;
    offset += pageSize;
  }

  const totalRepaired = baselineRepaired + targetRepaired + bothRepaired;
  const explanation =
    totalRepaired === 0
      ? 'No snapshots needed repair on this run. All findings were either already complete, or had legitimate null sides (missing_on_target / missing_on_baseline).'
      : `Repaired ${totalRepaired} findings. ${byDesignBaselineNull + byDesignTargetNull} findings have a legitimately null side (this is correct — by design for missing_on_* findings). ${trulyOrphaned} side(s) reference deleted products and can never be repaired.`;

  return ok({
    run_id: runId,
    scanned,
    already_complete: alreadyComplete,
    repaired: totalRepaired,
    baseline_repaired: baselineRepaired,
    target_repaired: targetRepaired,
    both_repaired: bothRepaired,
    by_design_baseline_null: byDesignBaselineNull,
    by_design_target_null: byDesignTargetNull,
    truly_orphaned: trulyOrphaned,
    explanation,
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function isPopulated(s: Record<string, unknown> | null | undefined): boolean {
  if (!s || typeof s !== 'object') return false;
  return Boolean(
    s.name_en || s.name_ar || s.normalized_name || s.source_sku ||
    s.matched_master_sku || s.barcode,
  );
}

function projectSnapshot(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id ?? null,
    product_id: r.id ?? null,
    platform: r.platform ?? null,
    source_sku: r.source_sku ?? null,
    matched_master_sku: r.matched_master_sku ?? null,
    name_en: r.name_en ?? null,
    name_ar: r.name_ar ?? null,
    normalized_name: r.normalized_name ?? null,
    barcode: r.barcode ?? null,
    brand: r.brand ?? null,
    category: r.category ?? null,
    category_name: r.category_name ?? null,
    subcategory_name: r.subcategory_name ?? null,
    variant_color: r.variant_color ?? null,
    variant_size: r.variant_size ?? null,
    variant_pack: r.variant_pack ?? null,
    price: r.price ?? null,
    stock_quantity: r.stock_quantity ?? null,
    image_url: r.image_url ?? null,
    image_filename: r.image_filename ?? null,
  };
}
