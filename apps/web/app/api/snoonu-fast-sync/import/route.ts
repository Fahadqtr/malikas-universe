/**
 * POST /api/snoonu-fast-sync/import
 *
 * Phase 13F.4. Fast Sync — upload a Snoonu xlsx export, parse it via
 * `parseSnoonuExportBuffer`, and UPSERT each row into platform_products.
 *
 * Body: multipart/form-data
 *   file: the Snoonu xlsx export (1144 rows × 21 cols today)
 *   label? : string — optional run label
 *
 * Match strategy (in order):
 *   1. snoonu_spi               — exact match (most stable; from prior sync)
 *   2. source_product_id        — exact match on Snoonu's SPI written previously
 *   3. normalized_name + platform='snoonu' — fallback for never-synced rows
 *
 * If no match → insert a brand-new platform_products row tagged platform='snoonu'.
 *
 * READ-ONLY against Snoonu Portal (this endpoint never makes outbound calls
 * to Snoonu). All writes go to our local Supabase.
 *
 * Returns:
 *   {
 *     run_id, import_id,
 *     total_rows, inserted, updated, unchanged, skipped,
 *     missing_spi, missing_name,
 *     prices_captured, stocks_captured, availability_captured,
 *     branch_data_coverage_pct,
 *     warnings, sample_changes
 *   }
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { Json } from '@malikas/db';
import {
  parseSnoonuExportBuffer,
  validateRow,
  type SnoonuExportRow,
  type ImportSummary,
} from '@/lib/reconciliation/snoonu-export-importer';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Helpers ───────────────────────────────────────────────────────────────

type ExistingRow = {
  id: number;
  snoonu_spi: string | null;
  source_product_id: string | null;
  normalized_name: string | null;
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  price: number | null;
  stock_quantity: number | null;
  platform_status: string | null;
  snoonu_branches: unknown;
  snoonu_price_ali_bin_abdullah: number | null;
  snoonu_price_al_aziziyah: number | null;
  snoonu_stock_ali_bin_abdullah: number | null;
  snoonu_stock_al_aziziyah: number | null;
  snoonu_availability_ali_bin_abdullah: boolean | null;
  snoonu_availability_al_aziziyah: boolean | null;
};

function buildUpdatePayload(row: SnoonuExportRow, syncedAt: string) {
  return {
    snoonu_spi: row.spi,
    source_product_id: row.spi, // mirror SPI into the shared field
    snoonu_export_row: row.row_index,
    snoonu_export_synced_at: syncedAt,
    name_en: row.name_en,
    name_ar: row.name_ar,
    description_en: row.description_en,
    description_ar: row.description_ar,
    price: row.derived.price,
    stock_quantity: row.derived.stock_quantity,
    platform_status: row.derived.platform_status,
    snoonu_branches: row.derived.snoonu_branches,
    snoonu_price_ali_bin_abdullah: row.price_ali,
    snoonu_price_al_aziziyah: row.price_aziziyah,
    snoonu_stock_ali_bin_abdullah: row.stock_ali,
    snoonu_stock_al_aziziyah: row.stock_aziziyah,
    snoonu_availability_ali_bin_abdullah: row.available_ali,
    snoonu_availability_al_aziziyah: row.available_aziziyah,
    normalized_name: row.derived.normalized_name,
  };
}

/**
 * Pick which existing row (if any) matches this export row, applying
 * the priority order: snoonu_spi → source_product_id → normalized_name.
 */
function findMatch(
  row: SnoonuExportRow,
  existingBySpi: Map<string, ExistingRow>,
  existingBySourceId: Map<string, ExistingRow>,
  existingByNormName: Map<string, ExistingRow>,
): ExistingRow | null {
  if (row.spi) {
    const m = existingBySpi.get(row.spi) ?? existingBySourceId.get(row.spi);
    if (m) return m;
  }
  if (row.derived.normalized_name) {
    const m = existingByNormName.get(row.derived.normalized_name);
    if (m) return m;
  }
  return null;
}

/**
 * Compare critical fields to detect whether this upsert is an effective
 * change. Coarse — name/price/stock/availability changes count, descriptions
 * count as a change because the export updates them frequently.
 */
function rowChanged(existing: ExistingRow, row: SnoonuExportRow): boolean {
  return (
    existing.name_en !== row.name_en ||
    existing.name_ar !== row.name_ar ||
    existing.description_en !== row.description_en ||
    existing.description_ar !== row.description_ar ||
    Number(existing.price ?? -1) !== Number(row.derived.price ?? -1) ||
    Number(existing.stock_quantity ?? -1) !== Number(row.derived.stock_quantity) ||
    existing.platform_status !== row.derived.platform_status ||
    existing.snoonu_price_ali_bin_abdullah !== row.price_ali ||
    existing.snoonu_price_al_aziziyah !== row.price_aziziyah ||
    existing.snoonu_stock_ali_bin_abdullah !== row.stock_ali ||
    existing.snoonu_stock_al_aziziyah !== row.stock_aziziyah ||
    existing.snoonu_availability_ali_bin_abdullah !== row.available_ali ||
    existing.snoonu_availability_al_aziziyah !== row.available_aziziyah
  );
}

// ─── Route handler ─────────────────────────────────────────────────────────

export const POST = withErrorHandling(async (req: NextRequest) => {
  // Owner-only gate FIRST — before formData/file read, parse, admin client, or DB.
  await requireActor(ROLE_SETS.ownerOnly);

  const form = await req.formData().catch(() => null);
  if (!form) return err('BAD_REQUEST', 'Expected multipart/form-data with file field', 400);

  const file = form.get('file');
  if (!(file instanceof Blob)) return err('NO_FILE', 'Missing file field', 400);

  const label = (form.get('label') as string | null) ?? null;
  const source_filename = (file as File).name || 'snoonu-export.xlsx';

  // ─── 1. Parse the xlsx ─────────────────────────────────────────────────
  const buf = Buffer.from(await file.arrayBuffer());
  let parsed;
  try {
    parsed = parseSnoonuExportBuffer(buf, source_filename);
  } catch (e) {
    console.error('[fast-sync/import] xlsx parse failed', e);
    return err('PARSE_FAILED', 'Invalid or unreadable file', 400);
  }

  const admin = createAdminSupabaseClient();

  // ─── 2. Create platform_imports + snoonu_fast_sync_runs rows ───────────
  const { data: importRow, error: importErr } = await admin
    .from('platform_imports')
    .insert({
      platform: 'snoonu',
      label: label ?? `Fast Sync — ${source_filename}`,
      source_mode: 'xlsx_upload',
      source_filename,
      total_rows: parsed.total_rows,
      detected_headers: parsed.rows[0]
        ? Object.keys(parsed.rows[0]).slice(0, 30)
        : [],
      status: 'parsing',
    })
    .select('id')
    .single();
  if (importErr || !importRow) {
    console.error('[fast-sync/import] platform_imports insert failed', importErr);
    return err('IMPORT_INSERT_FAILED', 'Import failed', 500);
  }

  const { data: runRow, error: runErr } = await admin
    .from('snoonu_fast_sync_runs')
    .insert({
      import_id: importRow.id,
      source_filename,
      total_rows: parsed.total_rows,
      status: 'running',
    })
    .select('id')
    .single();
  if (runErr || !runRow) {
    console.error('[fast-sync/import] snoonu_fast_sync_runs insert failed', runErr);
    return err('RUN_INSERT_FAILED', 'Import failed', 500);
  }

  const importId = importRow.id;
  const runId = runRow.id;

  // ─── 3. Preload existing Snoonu rows for fast matching ─────────────────
  const { data: existing, error: exErr } = await admin
    .from('platform_products')
    .select(
      `id, snoonu_spi, source_product_id, normalized_name, name_en, name_ar,
       description_en, description_ar, price, stock_quantity, platform_status,
       snoonu_branches,
       snoonu_price_ali_bin_abdullah, snoonu_price_al_aziziyah,
       snoonu_stock_ali_bin_abdullah, snoonu_stock_al_aziziyah,
       snoonu_availability_ali_bin_abdullah, snoonu_availability_al_aziziyah`,
    )
    .eq('platform', 'snoonu');
  if (exErr) {
    console.error('[fast-sync/import] load existing platform_products failed', exErr);
    return err('LOAD_EXISTING_FAILED', 'Import failed', 500);
  }

  const existingBySpi = new Map<string, ExistingRow>();
  const existingBySourceId = new Map<string, ExistingRow>();
  const existingByNormName = new Map<string, ExistingRow>();
  for (const r of (existing ?? []) as ExistingRow[]) {
    if (r.snoonu_spi) existingBySpi.set(r.snoonu_spi, r);
    if (r.source_product_id) existingBySourceId.set(r.source_product_id, r);
    if (r.normalized_name) existingByNormName.set(r.normalized_name, r);
  }

  // ─── 4. Iterate and upsert ─────────────────────────────────────────────
  const syncedAt = new Date().toISOString();
  const summary: ImportSummary = {
    total_rows: parsed.total_rows,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    missing_spi: 0,
    missing_name: 0,
    prices_captured: 0,
    stocks_captured: 0,
    availability_captured: 0,
    branch_data_coverage_pct: 0,
    warnings: parsed.warnings,
  };
  const sample_changes: Array<Record<string, unknown>> = [];

  // Batch updates in chunks to keep response time reasonable on 1144 rows.
  const updatePayloads: Array<{ id: number; patch: ReturnType<typeof buildUpdatePayload> }> = [];
  const insertPayloads: Array<ReturnType<typeof buildUpdatePayload> & {
    platform: 'snoonu';
    import_id: number;
    source_row_index: number;
    match_status: 'pending';
  }> = [];

  let bothBranchesPresent = 0;

  for (const row of parsed.rows) {
    const skipReason = validateRow(row);
    if (skipReason) {
      summary.skipped++;
      if (skipReason === 'missing_spi') summary.missing_spi++;
      if (skipReason === 'missing_name') summary.missing_name++;
      continue;
    }

    // Coverage counters
    if (row.price_ali !== null || row.price_aziziyah !== null) summary.prices_captured++;
    if (row.stock_ali !== null || row.stock_aziziyah !== null) summary.stocks_captured++;
    if (row.available_ali !== null || row.available_aziziyah !== null) summary.availability_captured++;
    if (
      (row.price_ali !== null || row.stock_ali !== null) &&
      (row.price_aziziyah !== null || row.stock_aziziyah !== null)
    )
      bothBranchesPresent++;

    const patch = buildUpdatePayload(row, syncedAt);
    const match = findMatch(row, existingBySpi, existingBySourceId, existingByNormName);

    if (!match) {
      // Insert
      insertPayloads.push({
        ...patch,
        platform: 'snoonu' as const,
        import_id: importId,
        source_row_index: row.row_index,
        match_status: 'pending' as const,
      });
      summary.inserted++;
      if (sample_changes.length < 20) {
        sample_changes.push({
          action: 'insert',
          row_index: row.row_index,
          spi: row.spi,
          name_en: row.name_en,
          price: patch.price,
          stock: patch.stock_quantity,
        });
      }
    } else if (rowChanged(match, row)) {
      updatePayloads.push({ id: match.id, patch });
      summary.updated++;
      if (sample_changes.length < 20) {
        sample_changes.push({
          action: 'update',
          id: match.id,
          spi: row.spi,
          name_en: row.name_en,
          before: {
            price: match.price,
            stock: match.stock_quantity,
            avail_ali: match.snoonu_availability_ali_bin_abdullah,
          },
          after: {
            price: patch.price,
            stock: patch.stock_quantity,
            avail_ali: row.available_ali,
          },
        });
      }
    } else {
      // Touch synced_at and snoonu_spi even on unchanged rows so audits show
      // they were re-confirmed by this import.
      updatePayloads.push({
        id: match.id,
        patch: {
          ...patch,
          // Keep the unchanged values explicitly — Supabase doesn't diff for us.
        },
      });
      summary.unchanged++;
    }
  }

  // Apply updates in batches of 100
  const CHUNK = 100;
  for (let i = 0; i < updatePayloads.length; i += CHUNK) {
    const chunk = updatePayloads.slice(i, i + CHUNK);
    // Fire updates in parallel within the chunk
    await Promise.all(
      chunk.map(({ id, patch }) =>
        admin.from('platform_products').update(patch).eq('id', id),
      ),
    );
  }

  // Bulk insert in batches
  for (let i = 0; i < insertPayloads.length; i += CHUNK) {
    const chunk = insertPayloads.slice(i, i + CHUNK);
    const { error: insErr } = await admin.from('platform_products').insert(chunk);
    if (insErr) {
      // Stop on first insert error. Log the real error server-side only; never
      // persist or return the raw DB message.
      console.error('[fast-sync/import] platform_products insert failed', insErr);
      await admin
        .from('snoonu_fast_sync_runs')
        .update({ status: 'error', error_message: 'Product import failed', completed_at: new Date().toISOString() })
        .eq('id', runId);
      return err('INSERT_FAILED', 'Product import failed', 500);
    }
  }

  // ─── 5. Finalize run + import rows ─────────────────────────────────────
  summary.branch_data_coverage_pct =
    parsed.total_rows > 0
      ? Number(((bothBranchesPresent / parsed.total_rows) * 100).toFixed(1))
      : 0;

  await admin
    .from('snoonu_fast_sync_runs')
    .update({
      inserted_rows: summary.inserted,
      updated_rows: summary.updated,
      unchanged_rows: summary.unchanged,
      skipped_rows: summary.skipped,
      missing_spi: summary.missing_spi,
      missing_name: summary.missing_name,
      prices_captured: summary.prices_captured,
      stocks_captured: summary.stocks_captured,
      availability_captured: summary.availability_captured,
      branch_data_coverage: summary.branch_data_coverage_pct,
      sample_changes: sample_changes as Json,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);

  await admin
    .from('platform_imports')
    .update({
      parsed_rows: summary.total_rows,
      matched_rows: summary.updated + summary.unchanged,
      unmatched_rows: summary.inserted,
      status: 'ready',
      completed_at: new Date().toISOString(),
    })
    .eq('id', importId);

  return ok({
    run_id: runId,
    import_id: importId,
    ...summary,
    sample_changes,
    next_steps: [
      {
        label: 'Map catalogs via Snoonu section pages',
        href: '/snoonu-fast-sync#catalog',
        phase: '13F.5',
      },
      {
        label: 'Rebuild browser audit queue (uncertain products only)',
        href: '/snoonu-browser-audit',
        phase: '13F.7',
      },
    ],
  });
});
