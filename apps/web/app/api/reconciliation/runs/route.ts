/**
 * POST /api/reconciliation/runs
 *
 * Start a new comparison: Snoonu baseline vs one or more target platforms.
 *
 * Body:
 *   {
 *     label?: string,
 *     baseline_import_id: number,                 // a platform_imports row where platform='snoonu'
 *     target_import_ids: number[],                // one per target platform
 *   }
 *
 * Behaviour:
 *   1. Validate that the baseline is Snoonu and the targets are non-Snoonu
 *   2. Create a reconciliation_runs row (status='running')
 *   3. For each target, load both sets of platform_products and run the comparator
 *   4. Bulk-insert all findings
 *   5. Update the run row with summary counts and status='completed'
 *
 * Returns: { run_id, status, findings_total, findings_by_type, summary }
 *
 * GET /api/reconciliation/runs
 *
 * List recent runs. ?limit=20 default.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import {
  compareSnoonuVsTarget,
  type Finding,
  type FindingType,
  type MappingRow,
  type PlatformProductRow,
} from '@/lib/reconciliation/comparator';
import {
  ALLOWED_SUGGESTED_ACTIONS,
  isAllowedSuggestedAction,
} from '@/lib/reconciliation/suggested-actions';

export const runtime = 'nodejs';
export const maxDuration = 180;

const StartSchema = z.object({
  label: z.string().max(120).optional(),
  baseline_import_id: z.number().int(),
  target_import_ids: z.array(z.number().int()).min(1).max(5),
});

// ─── GET — list runs ────────────────────────────────────────────────────────

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from('reconciliation_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  return ok({ runs: data ?? [] });
});

// ─── POST — start a run ─────────────────────────────────────────────────────

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = StartSchema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // 1. Load imports + validate platforms
  const allImportIds = [body.baseline_import_id, ...body.target_import_ids];
  const { data: imports } = await admin
    .from('platform_imports')
    .select('id, platform, status, parsed_rows')
    .in('id', allImportIds);

  if (!imports || imports.length !== allImportIds.length) {
    return err('IMPORTS_NOT_FOUND', 'One or more import IDs not found', 404);
  }

  const baseline = (imports as Array<{ id: number; platform: string; status: string }>).find(
    (i) => i.id === body.baseline_import_id,
  );
  if (!baseline) return err('NO_BASELINE', 'Baseline import missing', 400);
  if (baseline.platform !== 'snoonu') {
    return err('BAD_BASELINE_PLATFORM', `Baseline must be snoonu (got ${baseline.platform})`, 400);
  }

  const targetImports = body.target_import_ids.map((id) => {
    const r = (imports as Array<{ id: number; platform: string }>).find((x) => x.id === id);
    if (!r) throw new Error(`Target import ${id} missing`);
    return r;
  });
  if (targetImports.some((t) => t.platform === 'snoonu')) {
    return err('TARGET_IS_SNOONU', 'Cannot compare Snoonu to itself — pick a non-Snoonu target', 400);
  }

  const targetPlatforms = targetImports.map((t) => t.platform);

  // 2. Create run row
  const { data: runRow, error: runErr } = await admin
    .from('reconciliation_runs')
    .insert({
      label: body.label ?? null,
      baseline_platform: 'snoonu',
      baseline_import_id: body.baseline_import_id,
      target_platforms: targetPlatforms,
      target_import_ids: body.target_import_ids,
      status: 'running',
      created_by: user.id,
    })
    .select('id')
    .single();

  if (runErr || !runRow) return err('RUN_INSERT_FAILED', runErr?.message ?? 'unknown', 500);
  const runId = (runRow as { id: number }).id;

  // 3. Load baseline rows once
  const baselineRows = await loadPlatformProducts(admin, body.baseline_import_id);

  // 3b. Load persistent mappings — comparator honors confirmed_match / ignored_pair
  const { data: mappingRows } = await admin
    .from('platform_product_mappings')
    .select('baseline_master_sku, baseline_source_sku, target_platform, target_source_sku, mapping_type');
  const mappings: MappingRow[] = (mappingRows ?? []) as MappingRow[];

  // 4. For each target, run the comparator
  const allFindings: Finding[] = [];
  const byTypeTotal: Record<FindingType, number> = {} as Record<FindingType, number>;

  try {
    for (const target of targetImports) {
      const targetRows = await loadPlatformProducts(admin, target.id);
      const result = compareSnoonuVsTarget({
        target_platform: target.platform,
        baseline_rows: baselineRows,
        target_rows: targetRows,
        mappings,
      });
      for (const f of result.findings) {
        allFindings.push(f);
        byTypeTotal[f.finding_type] = (byTypeTotal[f.finding_type] ?? 0) + 1;
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin
      .from('reconciliation_runs')
      .update({ status: 'error', error_message: msg })
      .eq('id', runId);
    return err('COMPARATOR_FAILED', msg, 500);
  }

  // ════════════════════════════════════════════════════════════════════════
  // 5. AUDIT, ASSERT, INSERT, VERIFY  (Phase 13B root-cause fix)
  // ════════════════════════════════════════════════════════════════════════
  //
  // Old behavior: blindly map → insert → trust it worked. That allowed broken
  // data (null product_ids, null snapshots) to silently land in the DB.
  //
  // New behavior:
  //   (a) pre-insert audit — count emitted findings by type, snapshot presence,
  //       product_id presence; sample 3 emitted payloads
  //   (b) hard assertions — refuse to insert if ANY finding violates invariants
  //   (c) bulk insert in chunks, return-clause confirms how many rows the DB
  //       actually wrote
  //   (d) post-insert verify — read back a sample of persisted rows and check
  //       snapshots survived the round-trip; fail loudly if they didn't
  //   (e) every diagnostic value is returned in the API response so the user
  //       can debug from the network tab without reading logs
  //
  // No silent failures past this point.

  const preAudit = auditEmittedFindings(allFindings);

  // ─── Hard assertion 1: every finding must reference at least one product ─
  const noProductIdRefs = allFindings.filter(
    (f) => f.baseline_product_id == null && f.target_product_id == null,
  );
  if (noProductIdRefs.length > 0) {
    await admin
      .from('reconciliation_runs')
      .update({
        status: 'error',
        error_message: `Comparator emitted ${noProductIdRefs.length} findings with both product_ids null`,
      })
      .eq('id', runId);
    return err(
      'COMPARATOR_INVARIANT_VIOLATION',
      'Comparator emitted findings with no product references. These would be unrecoverable orphans.',
      500,
      {
        violation_count: noProductIdRefs.length,
        sample: noProductIdRefs.slice(0, 3),
      },
    );
  }

  // ─── Hard assertion 1b: every suggested_action must be in the allowed set
  //     This is the single source of truth defined in suggested-actions.ts.
  //     If this fires, the comparator emitted a value the DB CHECK rejects.
  //     Catches comparator/DB drift before it corrupts the run.
  const invalidActions: Array<{ finding_type: string; suggested_action: unknown }> = [];
  for (const f of allFindings) {
    if (f.suggested_action == null) continue;
    if (!isAllowedSuggestedAction(f.suggested_action)) {
      invalidActions.push({
        finding_type: f.finding_type,
        suggested_action: f.suggested_action,
      });
    }
  }
  if (invalidActions.length > 0) {
    await admin
      .from('reconciliation_runs')
      .update({
        status: 'error',
        error_message: `Comparator emitted ${invalidActions.length} findings with suggested_action not in ALLOWED_SUGGESTED_ACTIONS`,
      })
      .eq('id', runId);
    return err(
      'SUGGESTED_ACTION_INVALID',
      `Comparator emitted suggested_action values not in the canonical list. This would fail the DB CHECK constraint. Update lib/reconciliation/suggested-actions.ts AND generate a new migration that drops + recreates reconciliation_findings_suggested_action_check.`,
      500,
      {
        offending_count: invalidActions.length,
        offending_sample: invalidActions.slice(0, 5),
        allowed: ALLOWED_SUGGESTED_ACTIONS,
      },
    );
  }

  // ─── Hard assertion 2: every finding must carry at least one snapshot ───
  const noSnapshotRefs = allFindings.filter(
    (f) =>
      !isSnapshotPopulated(f.baseline_snapshot) &&
      !isSnapshotPopulated(f.target_snapshot),
  );
  if (noSnapshotRefs.length > 0) {
    await admin
      .from('reconciliation_runs')
      .update({
        status: 'error',
        error_message: `Comparator emitted ${noSnapshotRefs.length} findings with NO populated snapshots`,
      })
      .eq('id', runId);
    return err(
      'COMPARATOR_SNAPSHOT_VIOLATION',
      'Comparator emitted findings with no populated snapshots. These would render blank in the UI.',
      500,
      {
        violation_count: noSnapshotRefs.length,
        sample: noSnapshotRefs.slice(0, 3).map((f) => ({
          finding_type: f.finding_type,
          baseline_product_id: f.baseline_product_id,
          target_product_id: f.target_product_id,
          baseline_snapshot: f.baseline_snapshot,
          target_snapshot: f.target_snapshot,
        })),
      },
    );
  }

  // ─── 5b. Build the insert payload ──────────────────────────────────────
  const findingRows = allFindings.map((f) => ({
    run_id: runId,
    master_sku: f.master_sku,
    baseline_platform: 'snoonu',
    baseline_product_id: f.baseline_product_id,
    target_platform: f.target_platform,
    target_product_id: f.target_product_id,
    finding_type: f.finding_type,
    severity: f.severity,
    baseline_value: f.baseline_value,
    target_value: f.target_value,
    diff_meta: f.diff_meta,
    suggested_action: f.suggested_action,
    resolution_status: 'pending' as const,
    confidence: f.confidence ?? null,
    candidate_pairs: f.candidate_pairs ?? [],
    differing_tokens: f.differing_tokens ?? [],
    variant_family_id: f.variant_family_id ?? null,
    baseline_snapshot: f.baseline_snapshot,
    target_snapshot: f.target_snapshot,
    matching_reason: f.matching_reason,
  }));

  // ─── 5c. Insert in chunks, capturing returned row IDs ──────────────────
  let actuallyInserted = 0;
  const firstInsertedIds: number[] = [];

  for (let i = 0; i < findingRows.length; i += 1000) {
    const chunk = findingRows.slice(i, i + 1000);
    const { data: returned, error: insErr } = await admin
      .from('reconciliation_findings')
      .insert(chunk)
      .select('id');
    if (insErr) {
      await admin
        .from('reconciliation_runs')
        .update({ status: 'error', error_message: insErr.message })
        .eq('id', runId);
      return err('FINDINGS_INSERT_FAILED', insErr.message, 500, {
        inserted_before_failure: actuallyInserted,
        first_failing_chunk_index: i,
        emitted_total: findingRows.length,
        sample_chunk_row: chunk[0],
      });
    }
    const ids = (returned ?? []) as Array<{ id: number }>;
    actuallyInserted += ids.length;
    if (firstInsertedIds.length < 5) {
      for (const r of ids) {
        if (firstInsertedIds.length >= 5) break;
        firstInsertedIds.push(r.id);
      }
    }
  }

  // ─── 5d. Insert count must match emit count ────────────────────────────
  if (actuallyInserted !== findingRows.length) {
    await admin
      .from('reconciliation_runs')
      .update({
        status: 'error',
        error_message: `Insert mismatch: emitted ${findingRows.length}, inserted ${actuallyInserted}`,
      })
      .eq('id', runId);
    return err(
      'INSERT_COUNT_MISMATCH',
      `Emitted ${findingRows.length} findings but DB confirmed only ${actuallyInserted}. Some rows were rejected silently.`,
      500,
    );
  }

  // ─── 5e. Post-insert verify: read back the first 5 rows and check that
  //         snapshots + product_ids survived the round-trip ───────────────
  let postAudit: PostInsertAudit | null = null;
  if (firstInsertedIds.length > 0) {
    const { data: persisted } = await admin
      .from('reconciliation_findings')
      .select(
        'id, baseline_product_id, target_product_id, baseline_snapshot, target_snapshot, matching_reason',
      )
      .in('id', firstInsertedIds);

    const persistedSample = (persisted ?? []) as Array<{
      id: number;
      baseline_product_id: number | null;
      target_product_id: number | null;
      baseline_snapshot: unknown;
      target_snapshot: unknown;
      matching_reason: string | null;
    }>;

    let snapshotPersistedCount = 0;
    let productIdPersistedCount = 0;
    for (const p of persistedSample) {
      if (
        isSnapshotPopulated(p.baseline_snapshot as Record<string, unknown> | null) ||
        isSnapshotPopulated(p.target_snapshot as Record<string, unknown> | null)
      ) {
        snapshotPersistedCount++;
      }
      if (p.baseline_product_id != null || p.target_product_id != null) {
        productIdPersistedCount++;
      }
    }

    postAudit = {
      sampled_ids: firstInsertedIds,
      sample_size: persistedSample.length,
      snapshot_persisted: snapshotPersistedCount,
      product_id_persisted: productIdPersistedCount,
      sample_first_row: persistedSample[0] ?? null,
    };

    // If snapshots got nuked during persist, fail loudly. This catches the
    // exact bug the user reported (snapshots emitted correctly but landing
    // as null in the DB).
    if (persistedSample.length > 0 && snapshotPersistedCount === 0) {
      await admin
        .from('reconciliation_runs')
        .update({
          status: 'error',
          error_message: 'Snapshots emitted but not persisted — schema issue (run migration 0014?)',
        })
        .eq('id', runId);
      return err(
        'SNAPSHOT_PERSIST_FAILURE',
        'The comparator emitted populated snapshots, but reading back the first 5 inserted rows shows all snapshots are null. ' +
          'Most likely cause: migration 0014 (baseline_snapshot/target_snapshot columns) was not applied to this database, ' +
          'so Supabase silently dropped the unknown columns. Apply supabase/migrations/00000000000014_finding_snapshots.sql ' +
          'or APPLY_0014_AND_0015_COMBINED.sql and re-run.',
        500,
        { post_audit: postAudit, pre_audit: preAudit },
      );
    }
  }

  // ─── 6. Finalize run row ───────────────────────────────────────────────
  await admin
    .from('reconciliation_runs')
    .update({
      findings_total: allFindings.length,
      findings_by_type: byTypeTotal,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);

  return ok({
    run_id: runId,
    status: 'completed',
    findings_total: allFindings.length,
    findings_by_type: byTypeTotal,
    target_platforms: targetPlatforms,
    audit: {
      pre_insert: preAudit,
      actually_inserted: actuallyInserted,
      post_insert: postAudit,
    },
  });
});

// ─── Audit helpers (Phase 13B root-cause fix) ───────────────────────────────

type PreInsertAudit = {
  total: number;
  by_type: Record<string, number>;
  with_baseline_product_id: number;
  with_target_product_id: number;
  with_both_product_ids: number;
  with_neither_product_id: number;
  with_baseline_snapshot: number;
  with_target_snapshot: number;
  with_both_snapshots: number;
  with_neither_snapshot: number;
  sample_emitted: Array<{
    finding_type: string;
    baseline_product_id: number | null;
    target_product_id: number | null;
    baseline_snapshot_keys: string[];
    target_snapshot_keys: string[];
    matching_reason: string;
  }>;
};

type PostInsertAudit = {
  sampled_ids: number[];
  sample_size: number;
  snapshot_persisted: number;
  product_id_persisted: number;
  sample_first_row: unknown;
};

function auditEmittedFindings(findings: Finding[]): PreInsertAudit {
  const byType: Record<string, number> = {};
  let withBaselineId = 0;
  let withTargetId = 0;
  let withBothIds = 0;
  let withNeitherId = 0;
  let withBaselineSnap = 0;
  let withTargetSnap = 0;
  let withBothSnaps = 0;
  let withNeitherSnap = 0;

  for (const f of findings) {
    byType[f.finding_type] = (byType[f.finding_type] ?? 0) + 1;
    const hasB = f.baseline_product_id != null;
    const hasT = f.target_product_id != null;
    if (hasB) withBaselineId++;
    if (hasT) withTargetId++;
    if (hasB && hasT) withBothIds++;
    if (!hasB && !hasT) withNeitherId++;

    const snapB = isSnapshotPopulated(f.baseline_snapshot);
    const snapT = isSnapshotPopulated(f.target_snapshot);
    if (snapB) withBaselineSnap++;
    if (snapT) withTargetSnap++;
    if (snapB && snapT) withBothSnaps++;
    if (!snapB && !snapT) withNeitherSnap++;
  }

  const sample = findings.slice(0, 3).map((f) => ({
    finding_type: f.finding_type,
    baseline_product_id: f.baseline_product_id,
    target_product_id: f.target_product_id,
    baseline_snapshot_keys: f.baseline_snapshot ? Object.keys(f.baseline_snapshot) : [],
    target_snapshot_keys: f.target_snapshot ? Object.keys(f.target_snapshot) : [],
    matching_reason: f.matching_reason ?? '',
  }));

  return {
    total: findings.length,
    by_type: byType,
    with_baseline_product_id: withBaselineId,
    with_target_product_id: withTargetId,
    with_both_product_ids: withBothIds,
    with_neither_product_id: withNeitherId,
    with_baseline_snapshot: withBaselineSnap,
    with_target_snapshot: withTargetSnap,
    with_both_snapshots: withBothSnaps,
    with_neither_snapshot: withNeitherSnap,
    sample_emitted: sample,
  };
}

function isSnapshotPopulated(s: Record<string, unknown> | null | undefined | unknown): boolean {
  if (!s || typeof s !== 'object') return false;
  const obj = s as Record<string, unknown>;
  return Boolean(
    obj.name_en || obj.name_ar || obj.normalized_name || obj.source_sku ||
    obj.matched_master_sku || obj.barcode,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function loadPlatformProducts(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  importId: number,
): Promise<PlatformProductRow[]> {
  const all: PlatformProductRow[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await admin
      .from('platform_products')
      .select(
        `id, platform, source_sku, barcode, name_en, name_ar, brand, category,
         price, discount_price, stock_quantity, stock_status, platform_status,
         image_url, image_filename, matched_master_sku, match_status, variants,
         normalized_name, normalized_brand, name_root, name_token_signature,
         variant_color, variant_shade, variant_size, variant_volume_value,
         variant_volume_unit, variant_pack, variant_model, variant_type,
         raw_category, raw_subcategory, category_name, subcategory_name,
         category_confidence, category_source, category_missing,
         snoonu_category, snoonu_secondary_categories`,
      )
      .eq('import_id', importId)
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`load platform_products: ${error.message}`);
    const batch = (data ?? []) as PlatformProductRow[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
