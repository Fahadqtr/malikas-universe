/**
 * GET /api/reconciliation/findings/[id]
 *
 * Inspector for a single finding. Returns the raw DB row + joined platform
 * products + the projected snapshot (if the persisted one was missing).
 * Use this to diagnose "Unknown product" issues end-to-end.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export const GET = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const findingId = Number(params.id);
  if (!Number.isInteger(findingId) || findingId <= 0) {
    return err('BAD_FINDING_ID', 'Invalid finding id', 400);
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
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
    )
    .eq('id', findingId)
    .maybeSingle();

  if (error) return err('QUERY_FAILED', error.message, 500);
  if (!data) return err('NOT_FOUND', `Finding ${findingId} not found`, 404);

  const f = data as unknown as Record<string, unknown> & {
    baseline_snapshot: Record<string, unknown> | null;
    target_snapshot: Record<string, unknown> | null;
    baseline: Record<string, unknown> | null;
    target: Record<string, unknown> | null;
  };

  return ok({
    finding: f,
    health: {
      baseline_snapshot_present: !!f.baseline_snapshot,
      baseline_snapshot_populated: snapshotPopulated(f.baseline_snapshot),
      target_snapshot_present: !!f.target_snapshot,
      target_snapshot_populated: snapshotPopulated(f.target_snapshot),
      baseline_joined_present: !!f.baseline,
      target_joined_present: !!f.target,
    },
  });
});

function snapshotPopulated(s: Record<string, unknown> | null | undefined): boolean {
  if (!s || typeof s !== 'object') return false;
  return Boolean(
    s.name_en || s.name_ar || s.normalized_name || s.source_sku ||
    s.matched_master_sku || s.barcode,
  );
}
