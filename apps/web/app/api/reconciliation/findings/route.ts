/**
 * GET /api/reconciliation/findings
 *
 * Paginated list of findings with filters. Drives the reconciliation dashboard.
 *
 * Query params:
 *   ?run_id=        - required
 *   ?type=          - finding_type filter (single value)
 *   ?platform=      - target_platform filter
 *   ?severity=      - severity filter
 *   ?resolution=    - resolution_status filter (pending|reviewed|applied|dismissed)
 *   ?page=1&limit=50
 *
 * Each row includes the joined baseline + target product names for display.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const runId = Number(url.searchParams.get('run_id'));
  if (!Number.isInteger(runId) || runId <= 0) {
    return err('BAD_RUN_ID', 'run_id is required', 400);
  }

  const type = url.searchParams.get('type');
  const platform = url.searchParams.get('platform');
  const severity = url.searchParams.get('severity');
  const resolution = url.searchParams.get('resolution');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = (page - 1) * limit;

  const admin = createAdminSupabaseClient();

  // Phase 13B fix: pull the FULL set of fields needed to project a snapshot
  // on the fly if the persisted baseline_snapshot/target_snapshot is null.
  // This keeps the dashboard self-healing even for old runs (run #5, #7 etc.)
  // whose snapshots didn't make it into the DB.
  let q = admin
    .from('reconciliation_findings')
    .select(
      `*,
       baseline:platform_products!baseline_product_id (
         id, platform, source_sku, name_en, name_ar, normalized_name, barcode,
         matched_master_sku, price, stock_quantity, image_url, image_filename,
         brand, category, category_name, subcategory_name,
         variant_color, variant_size, variant_pack
       ),
       target:platform_products!target_product_id (
         id, platform, source_sku, name_en, name_ar, normalized_name, barcode,
         matched_master_sku, price, stock_quantity, image_url, image_filename,
         brand, category, category_name, subcategory_name,
         variant_color, variant_size, variant_pack
       )
      `,
      { count: 'exact' },
    )
    .eq('run_id', runId);

  if (type) q = q.eq('finding_type', type);
  if (platform) q = q.eq('target_platform', platform);
  if (severity) q = q.eq('severity', severity);
  if (resolution) q = q.eq('resolution_status', resolution);

  q = q.order('severity', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) return err('QUERY_FAILED', error.message, 500);

  // ─── Self-healing snapshot projection ───────────────────────────────────
  // For every row where the persisted JSONB snapshot is null/empty BUT we
  // have a joined platform_products row, project a snapshot on the fly so
  // the UI always renders. This protects against legacy findings (run #5 / #7)
  // that were inserted before migration 0014 fully took effect.
  let healed = 0;
  const projected = (data ?? []).map((row) => {
    const f = row as Record<string, unknown> & {
      baseline_snapshot: ProductSnapshot | null;
      target_snapshot: ProductSnapshot | null;
      baseline: JoinedRow | null;
      target: JoinedRow | null;
    };
    if (!isPopulatedSnapshot(f.baseline_snapshot) && f.baseline) {
      f.baseline_snapshot = projectAsSnapshot(f.baseline);
      healed++;
    }
    if (!isPopulatedSnapshot(f.target_snapshot) && f.target) {
      f.target_snapshot = projectAsSnapshot(f.target);
      healed++;
    }
    return f;
  });

  return ok({
    findings: projected,
    page,
    limit,
    total: count ?? 0,
    healed_snapshots: healed,
  });
});

// ─── Snapshot projection helpers ────────────────────────────────────────────

type JoinedRow = {
  id: number;
  platform?: string | null;
  source_sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  normalized_name: string | null;
  barcode: string | null;
  matched_master_sku: string | null;
  price: number | null;
  stock_quantity?: number | null;
  image_url: string | null;
  image_filename?: string | null;
  brand?: string | null;
  category?: string | null;
  category_name?: string | null;
  subcategory_name?: string | null;
  variant_color?: string | null;
  variant_size?: string | null;
  variant_pack?: number | null;
};

type ProductSnapshot = {
  id?: number | null;
  platform?: string | null;
  product_id?: number | null;
  source_sku?: string | null;
  matched_master_sku?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  normalized_name?: string | null;
  barcode?: string | null;
  brand?: string | null;
  category?: string | null;
  category_name?: string | null;
  subcategory_name?: string | null;
  variant_color?: string | null;
  variant_size?: string | null;
  variant_pack?: number | null;
  price?: number | null;
  stock_quantity?: number | null;
  image_url?: string | null;
  image_filename?: string | null;
};

/** A snapshot is "populated" if it exists and at least one identifying field is non-empty. */
function isPopulatedSnapshot(s: ProductSnapshot | null | undefined): s is ProductSnapshot {
  if (!s || typeof s !== 'object') return false;
  return Boolean(
    s.name_en || s.name_ar || s.normalized_name || s.source_sku ||
    s.matched_master_sku || s.barcode,
  );
}

function projectAsSnapshot(r: JoinedRow): ProductSnapshot {
  return {
    id: r.id,
    product_id: r.id,
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
