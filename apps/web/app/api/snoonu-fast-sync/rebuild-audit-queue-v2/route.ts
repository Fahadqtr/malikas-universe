/**
 * POST /api/snoonu-fast-sync/rebuild-audit-queue-v2
 *
 * Phase 13F.15. Smarter audit queue rebuild that operates on Fast Sync rows
 * (those with snoonu_spi populated) rather than legacy import rows. The old
 * audit queue mostly points to legacy rows (no SPI, no category) which the
 * v1 rebuild couldn't prune.
 *
 * Strategy:
 *   1. Archive all pending audits from the previous queue (mark
 *      audit_status='skipped' reason 'legacy_replaced_by_v2').
 *   2. Find every Fast Sync row (snoonu_spi populated) that is still
 *      uncertain — apply the same rules but on FRESH rows.
 *   3. Insert new pending audits for those uncertain Fast Sync rows.
 *   4. Categorize the priority + reason per row.
 *
 * Uncertainty rules (FRESH rows only):
 *   a. snoonu_category IS NULL                          → priority 10, missing_snoonu_catalog
 *   b. catalog_confidence < 0.75                        → priority 20, low_catalog_confidence
 *   c. snoonu_branches empty/null                       → priority 15, missing_branch_data
 *   d. product name suggests bundle/set/options         → priority 25, suspected_options
 *
 * READ-ONLY against Snoonu. Local-DB write only.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({});

type Counts = {
  pending: number; audited: number; verified: number; applied: number; skipped: number; error: number;
};

async function countByStatus(admin: ReturnType<typeof createAdminSupabaseClient>, importId: number): Promise<Counts> {
  const statuses = ['pending', 'audited', 'verified', 'applied', 'skipped', 'error'] as const;
  const counts: Counts = { pending: 0, audited: 0, verified: 0, applied: 0, skipped: 0, error: 0 };
  await Promise.all(statuses.map(async (s) => {
    const { count } = await admin
      .from('snoonu_browser_audits')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', importId)
      .eq('audit_status', s);
    counts[s] = count ?? 0;
  }));
  return counts;
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  Body.parse(await req.json().catch(() => ({})));
  const admin = createAdminSupabaseClient();

  // ─── 1. Resolve latest Snoonu import_id ────────────────────────────────
  const { data: importRow } = await admin
    .from('platform_imports')
    .select('id')
    .eq('platform', 'snoonu')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const importId = (importRow as { id: number } | null)?.id ?? 0;
  if (!importId) return err('NO_IMPORT', 'No Snoonu imports found.', 400);

  const before = await countByStatus(admin, importId);

  // ─── 2. Archive existing pending audits (legacy v1 queue) ──────────────
  // PAGINATE — Supabase select() caps at 1000 rows.
  const oldPendingIds: number[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await admin
      .from('snoonu_browser_audits')
      .select('id')
      .eq('import_id', importId)
      .eq('audit_status', 'pending')
      .order('id', { ascending: true })
      .range(offset, offset + 999);
    if (error) break;
    const chunk = (data ?? []) as Array<{ id: number }>;
    if (chunk.length === 0) break;
    oldPendingIds.push(...chunk.map((r) => r.id));
    if (chunk.length < 1000) break;
  }
  let archived = 0;
  const archiveErrors: string[] = [];
  if (oldPendingIds.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < oldPendingIds.length; i += CHUNK) {
      const slice = oldPendingIds.slice(i, i + CHUNK);
      const { error, count } = await admin
        .from('snoonu_browser_audits')
        .update({ audit_status: 'skipped', audit_notes: 'Replaced by v2 rebuild (Fast Sync row–based queue).' }, { count: 'exact' })
        .in('id', slice);
      if (error) archiveErrors.push(error.message.slice(0, 120));
      else archived += count ?? slice.length;
    }
  }

  // ─── 3. Build new queue from Fast Sync rows ────────────────────────────
  // PAGINATE — Supabase select() caps at 1000 rows.
  const rows: Array<{
    id: number; snoonu_spi: string | null; name_en: string | null;
    snoonu_category: string | null; snoonu_secondary_categories: string[] | null;
    catalog_source: string | null; catalog_confidence: number | null;
    snoonu_branches: unknown[] | null;
  }> = [];
  const freshErrors: string[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await admin
      .from('platform_products')
      .select(
        `id, snoonu_spi, name_en, snoonu_category, snoonu_secondary_categories,
         catalog_source, catalog_confidence, snoonu_branches`,
      )
      .eq('platform', 'snoonu')
      .not('snoonu_spi', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + 999);
    if (error) { freshErrors.push(error.message.slice(0, 120)); break; }
    const chunk = (data ?? []) as typeof rows;
    if (chunk.length === 0) break;
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }

  // Categorize each row by uncertainty reason
  type Reason = 'missing_snoonu_catalog' | 'low_catalog_confidence' | 'missing_branch_data' | 'suspected_options';
  const buckets = {
    missing_snoonu_catalog: [] as number[],
    missing_branch_data: [] as number[],
    low_catalog_confidence: [] as number[],
    suspected_options: [] as number[],
  } satisfies Record<Reason, number[]>;

  function hasBundleKeyword(name: string | null): boolean {
    if (!name) return false;
    return /\b(set|bundle|combo|kit|pack|gift)\b/i.test(name);
  }

  for (const r of rows) {
    const hasCategory = r.snoonu_category !== null;
    const confLow = r.catalog_confidence !== null && Number(r.catalog_confidence) < 0.75;
    const noBranches = !Array.isArray(r.snoonu_branches) || r.snoonu_branches.length < 2;
    if (!hasCategory) buckets.missing_snoonu_catalog.push(r.id);
    else if (confLow) buckets.low_catalog_confidence.push(r.id);
    if (noBranches) buckets.missing_branch_data.push(r.id);
    // has_options is captured on snoonu_browser_audits not platform_products.
    // If the name looks like a bundle/set, flag it for audit.
    if (hasBundleKeyword(r.name_en)) buckets.suspected_options.push(r.id);
  }

  // Insert pending audits — but first need to skip any product_id that ALREADY has
  // a NON-skipped/NON-error audit (so we don't double-queue). Build that set.
  const { data: existingActiveAudits } = await admin
    .from('snoonu_browser_audits')
    .select('product_id')
    .in('audit_status', ['pending', 'audited', 'verified', 'applied']);
  const productIdsWithActive = new Set(
    ((existingActiveAudits ?? []) as Array<{ product_id: number }>).map((r) => r.product_id),
  );

  const toInsert: Array<{ product_id: number; import_id: number; audit_status: 'pending'; audit_priority: number; audit_reason: Reason; snoonu_spi: string | null }> = [];
  const seen = new Set<number>();
  const priorityByReason: Record<Reason, number> = {
    missing_snoonu_catalog: 10,
    missing_branch_data: 15,
    low_catalog_confidence: 20,
    suspected_options: 25,
  };
  function push(reason: Reason, ids: number[]) {
    for (const pid of ids) {
      if (seen.has(pid)) continue;
      if (productIdsWithActive.has(pid)) continue; // already queued from earlier rebuild
      seen.add(pid);
      const row = rows.find((r) => r.id === pid);
      toInsert.push({
        product_id: pid,
        import_id: importId,
        audit_status: 'pending',
        audit_priority: priorityByReason[reason],
        audit_reason: reason,
        snoonu_spi: row?.snoonu_spi ?? null,
      });
    }
  }
  push('missing_snoonu_catalog', buckets.missing_snoonu_catalog);
  push('missing_branch_data', buckets.missing_branch_data);
  push('low_catalog_confidence', buckets.low_catalog_confidence);
  push('suspected_options', buckets.suspected_options);

  let inserted = 0;
  const insertErrors: string[] = [];
  if (toInsert.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const slice = toInsert.slice(i, i + CHUNK);
      const { error: insErr } = await admin.from('snoonu_browser_audits').insert(slice);
      if (insErr) insertErrors.push(insErr.message.slice(0, 120));
      else inserted += slice.length;
    }
  }

  const after = await countByStatus(admin, importId);

  // ─── 4. Sample top-20 of new queue + bucket counts ─────────────────────
  const { data: sample } = await admin
    .from('snoonu_browser_audits')
    .select(`id, audit_priority, audit_reason, snoonu_spi,
       product:platform_products!product_id (id, name_en, name_ar, snoonu_category, catalog_confidence, price)`)
    .eq('import_id', importId)
    .eq('audit_status', 'pending')
    .order('audit_priority', { ascending: true })
    .order('id', { ascending: true })
    .limit(20);
  const sample_queue = ((sample ?? []) as Array<{
    id: number; audit_priority: number; audit_reason: string | null; snoonu_spi: string | null;
    product: { id: number; name_en: string | null; name_ar: string | null; snoonu_category: string | null; catalog_confidence: number | null; price: number | null } | null;
  }>).map((r) => ({
    audit_id: r.id,
    product_id: r.product?.id ?? null,
    name_en: r.product?.name_en ?? null,
    snoonu_category: r.product?.snoonu_category ?? null,
    price: r.product?.price ?? null,
    catalog_confidence: r.product?.catalog_confidence ?? null,
    priority: r.audit_priority,
    reason: r.audit_reason,
  }));

  // Bucket counts after
  const counts = {
    still_missing_catalog: buckets.missing_snoonu_catalog.length,
    missing_branch_data: buckets.missing_branch_data.length,
    low_confidence: buckets.low_catalog_confidence.length,
    suspected_options: buckets.suspected_options.length,
  };

  return ok({
    import_id: importId,
    before,
    archived,
    inserted,
    after,
    counts,
    diagnostics: {
      old_pending_loaded: oldPendingIds.length,
      fresh_rows_loaded: rows.length,
      to_insert_after_dedup: toInsert.length,
      product_ids_with_active_audit: productIdsWithActive.size,
      archive_errors: archiveErrors,
      insert_errors: insertErrors,
      fresh_errors: freshErrors,
    },
    sample_queue,
    next_steps: [{ label: 'Open audit queue', href: '/snoonu-browser-audit', phase: '13E' }],
  });
});
