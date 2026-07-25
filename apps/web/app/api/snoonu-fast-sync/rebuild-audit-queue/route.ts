/**
 * POST /api/snoonu-fast-sync/rebuild-audit-queue
 *
 * Phase 13F.7. After Fast Sync + catalog section scrape have done the heavy
 * lifting, this endpoint prunes the browser audit queue so only TRULY
 * UNCERTAIN products remain.
 *
 * Workflow:
 *   1. Find the most recent Snoonu import (or use ?import_id=).
 *   2. SKIP existing pending audits whose product is no longer uncertain —
 *      mark them audit_status='skipped' with reason 'resolved_by_fast_sync'.
 *   3. INSERT new pending audits for products that ARE uncertain and aren't
 *      already queued.
 *   4. Return before/after counts + a sample of the queue.
 *
 * Uncertainty rules (a product is "uncertain" if ANY of these is true):
 *   a. snoonu_category IS NULL                                          → 'missing_snoonu_catalog'
 *   b. catalog_source = 'inferred' AND catalog_confidence < 0.75        → 'low_catalog_confidence'
 *   c. catalog_source = 'catalog_section_page' AND
 *      catalog_confidence < 0.80                                        → 'low_section_match_confidence'
 *   d. snoonu_branches is empty (no Fast Sync ran on this product)       → 'missing_branch_data'
 *   e. has_options unknown AND product name looks like a bundle/set      → 'suspected_options'
 *   f. unresolved reconciliation_findings.possible_match / price_mismatch → 'finding_unresolved'
 *
 * READ-ONLY against Snoonu Portal. Only writes to local DB.
 *
 * Body:
 *   { import_id?: number }
 *
 * Returns:
 *   {
 *     before: { pending, audited, applied, skipped, error },
 *     pruned: number,         // pending rows skipped because resolved
 *     enqueued_new: number,   // new pending rows added
 *     after:  { pending, audited, applied, skipped, error },
 *     sample_queue: Array<{ product_id, name_en, reason, priority }>
 *   }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  import_id: z.number().int().positive().optional(),
});

type Counts = {
  pending: number;
  audited: number;
  verified: number;
  applied: number;
  skipped: number;
  error: number;
};

async function countByStatus(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  importId: number,
): Promise<Counts> {
  const statuses = ['pending', 'audited', 'verified', 'applied', 'skipped', 'error'] as const;
  const counts: Counts = { pending: 0, audited: 0, verified: 0, applied: 0, skipped: 0, error: 0 };
  await Promise.all(
    statuses.map(async (s) => {
      const { count } = await admin
        .from('snoonu_browser_audits')
        .select('id', { count: 'exact', head: true })
        .eq('import_id', importId)
        .eq('audit_status', s);
      counts[s] = count ?? 0;
    }),
  );
  return counts;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Body.parse(await req.json().catch(() => ({})));
  const admin = createAdminSupabaseClient();

  // ─── 1. Resolve import_id ──────────────────────────────────────────────
  let importId = body.import_id ?? 0;
  if (!importId) {
    const { data } = await admin
      .from('platform_imports')
      .select('id')
      .eq('platform', 'snoonu')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    importId = (data as { id: number } | null)?.id ?? 0;
  }
  if (!importId) {
    return err('NO_IMPORT', 'No Snoonu imports found — run Fast Sync import first.', 400);
  }

  const before = await countByStatus(admin, importId);

  // ─── 2. Prune resolved pending audits ──────────────────────────────────
  // A row is resolved if its current product now has:
  //   - snoonu_category set
  //   - AND catalog_confidence >= 0.80 (or null which we treat as ok)
  //   - AND has both Snoonu branches captured
  // We DON'T prune rows in 'audited'/'verified'/'applied' — those have value.
  const { data: pendingRows } = await admin
    .from('snoonu_browser_audits')
    .select(
      `id, product_id, audit_reason,
       product:platform_products!product_id (
         snoonu_category, catalog_confidence, snoonu_branches, has_options
       )`,
    )
    .eq('import_id', importId)
    .eq('audit_status', 'pending');

  const prunedIds: number[] = [];
  for (const row of (pendingRows ?? []) as unknown as Array<{
    id: number;
    product_id: number;
    audit_reason: string | null;
    product: {
      snoonu_category: string | null;
      catalog_confidence: number | null;
      snoonu_branches: unknown[] | null;
      has_options: boolean | null;
    } | null;
  }>) {
    if (!row.product) continue;
    const hasCategory = row.product.snoonu_category !== null;
    const confidentEnough =
      row.product.catalog_confidence === null ||
      Number(row.product.catalog_confidence) >= 0.8;
    const branchesCaptured =
      Array.isArray(row.product.snoonu_branches) &&
      (row.product.snoonu_branches as unknown[]).length >= 2;
    if (hasCategory && confidentEnough && branchesCaptured) {
      prunedIds.push(row.id);
    }
  }

  if (prunedIds.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < prunedIds.length; i += CHUNK) {
      await admin
        .from('snoonu_browser_audits')
        .update({
          audit_status: 'skipped',
          audit_notes: 'Resolved by Fast Sync (xlsx + catalog section scrape).',
        })
        .in('id', prunedIds.slice(i, i + CHUNK));
    }
  }

  // ─── 3. Enqueue new uncertain products ────────────────────────────────
  // Call the existing PL/pgSQL helper for the bulk of cases (missing
  // catalog, low confidence, unresolved findings).
  await admin.rpc('enqueue_snoonu_audits', { p_import_id: importId, p_limit: 5000 });

  // Add a Fast-Sync specific rule: products without branches captured.
  // (the SQL function predates 13F; we add this as a JS-side pass.)
  const { data: noBranchRows } = await admin
    .from('platform_products')
    .select('id')
    .eq('platform', 'snoonu')
    .eq('import_id', importId)
    .or('snoonu_branches.is.null,snoonu_branches.eq.[]');

  const noBranchIds = ((noBranchRows ?? []) as Array<{ id: number }>).map((r) => r.id);
  if (noBranchIds.length > 0) {
    // Insert pending audits for those that don't already have an active row.
    const { data: existingForIds } = await admin
      .from('snoonu_browser_audits')
      .select('product_id, audit_status')
      .in('product_id', noBranchIds);
    const activeProductIds = new Set(
      ((existingForIds ?? []) as Array<{ product_id: number; audit_status: string }>)
        .filter((r) => r.audit_status !== 'skipped' && r.audit_status !== 'error')
        .map((r) => r.product_id),
    );

    const toInsert = noBranchIds
      .filter((id) => !activeProductIds.has(id))
      .map((product_id) => ({
        product_id,
        import_id: importId,
        audit_status: 'pending' as const,
        audit_priority: 15,
        audit_reason: 'missing_branch_data',
      }));

    if (toInsert.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        await admin.from('snoonu_browser_audits').insert(toInsert.slice(i, i + CHUNK));
      }
    }
  }

  const after = await countByStatus(admin, importId);
  const enqueued_new = Math.max(0, after.pending - (before.pending - prunedIds.length));

  // ─── 4. Sample the resulting queue for the UI ──────────────────────────
  const { data: sample } = await admin
    .from('snoonu_browser_audits')
    .select(
      `id, audit_priority, audit_reason,
       product:platform_products!product_id (id, name_en, snoonu_category, catalog_confidence)`,
    )
    .eq('import_id', importId)
    .eq('audit_status', 'pending')
    .order('audit_priority', { ascending: true })
    .order('id', { ascending: true })
    .limit(20);

  const sample_queue = ((sample ?? []) as unknown as Array<{
    id: number;
    audit_priority: number;
    audit_reason: string | null;
    product: { id: number; name_en: string | null; snoonu_category: string | null; catalog_confidence: number | null } | null;
  }>).map((r) => ({
    audit_id: r.id,
    product_id: r.product?.id ?? null,
    name_en: r.product?.name_en ?? null,
    snoonu_category: r.product?.snoonu_category ?? null,
    catalog_confidence: r.product?.catalog_confidence ?? null,
    priority: r.audit_priority,
    reason: r.audit_reason,
  }));

  return ok({
    import_id: importId,
    before,
    pruned: prunedIds.length,
    enqueued_new,
    after,
    sample_queue,
    next_steps: [
      {
        label: 'Open audit queue',
        href: '/snoonu-browser-audit',
        phase: '13E',
      },
    ],
  });
});
