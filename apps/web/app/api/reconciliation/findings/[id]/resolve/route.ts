/**
 * POST /api/reconciliation/findings/[id]/resolve
 *
 * Resolve one finding. Optionally create a persistent mapping so future runs
 * stop flagging this pair.
 *
 * Body:
 *   {
 *     action: 'mark_matched' | 'ignore' | 'confirm_missing' | 'create_mapping' | 'dismiss',
 *     notes?: string,
 *     // for mark_matched / ignore / create_mapping — optional override of the
 *     // pair represented by the finding itself
 *     mapping_target_sku?: string,
 *     mapping_baseline_sku?: string,
 *     mapping_master_sku?: string,
 *   }
 *
 * Behaviour by action:
 *   mark_matched      → resolution_status='applied', mapping_type='confirmed_match'
 *   ignore            → resolution_status='dismissed', mapping_type='ignored_pair'
 *   confirm_missing   → resolution_status='applied' (no mapping written)
 *   create_mapping    → resolution_status='applied', mapping_type='manual_link'
 *   dismiss           → resolution_status='dismissed' (no mapping)
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import {
  buildMappingPayload,
  assertPayloadHasStableKeys,
  type ProductLike,
} from '@/lib/reconciliation/mapping-payload';

export const runtime = 'nodejs';

const Schema = z.object({
  action: z.enum(['mark_matched', 'ignore', 'confirm_missing', 'create_mapping', 'dismiss']),
  notes: z.string().max(2000).optional(),
  mapping_target_sku: z.string().optional(),
  mapping_baseline_sku: z.string().optional(),
  mapping_master_sku: z.string().optional(),
});

type RouteContext = { params: { id: string } };

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const findingId = Number(params.id);
  if (!Number.isInteger(findingId) || findingId <= 0) {
    return err('BAD_FINDING_ID', 'Invalid finding id', 400);
  }

  const body = Schema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // Load finding + its joined product rows. The * pull on platform_products
  // gives us source_sku, matched_master_sku, barcode, normalized_name, name_en,
  // name_ar — everything buildMappingPayload's fallback chain needs.
  const { data: finding } = await admin
    .from('reconciliation_findings')
    .select(
      `*,
       baseline:platform_products!baseline_product_id(*),
       target:platform_products!target_product_id(*)`,
    )
    .eq('id', findingId)
    .maybeSingle();

  if (!finding) return err('FINDING_NOT_FOUND', `Finding ${findingId} not found`, 404);

  const f = finding as {
    id: number;
    master_sku: string | null;
    target_platform: string;
    confidence: number | null;
    baseline_snapshot: ProductLike | null;
    target_snapshot: ProductLike | null;
    baseline: ProductLike | null;
    target: (ProductLike & { source_product_id?: string | null }) | null;
  };

  // ─── Decide resolution status + mapping creation ────────────────────────
  let nextResolution: 'applied' | 'dismissed' = 'applied';
  let mappingType: 'confirmed_match' | 'ignored_pair' | 'manual_link' | null = null;

  switch (body.action) {
    case 'mark_matched':
      mappingType = 'confirmed_match';
      nextResolution = 'applied';
      break;
    case 'ignore':
      mappingType = 'ignored_pair';
      nextResolution = 'dismissed';
      break;
    case 'create_mapping':
      mappingType = 'manual_link';
      nextResolution = 'applied';
      break;
    case 'confirm_missing':
      nextResolution = 'applied';
      break;
    case 'dismiss':
      nextResolution = 'dismissed';
      break;
  }

  // ─── Write mapping if needed ────────────────────────────────────────────
  let mappingId: number | null = null;
  let mappingPayloadInfo: ReturnType<typeof buildMappingPayload> = null;
  if (mappingType) {
    // Build via the fallback-aware resolver. This:
    //   - tries snapshot → joined row → barcode → synthetic in priority order
    //   - returns null only if both sides have literally nothing
    //   - never throws on missing SKUs
    //
    // Operator overrides from the request body still win.
    mappingPayloadInfo = buildMappingPayload({
      baseline_snapshot: f.baseline_snapshot,
      baseline_product: f.baseline,
      target_snapshot: f.target_snapshot,
      target_product: f.target,
      finding_master_sku: f.master_sku,
      baseline_platform: 'snoonu',
      target_platform: f.target_platform,
    });

    if (!mappingPayloadInfo) {
      return err(
        'MAPPING_NO_DATA',
        'Cannot create a mapping: both baseline and target have no identifying data ' +
          '(no SKU, no barcode, no name, no master_sku). The finding is too empty to map.',
        400,
        {
          finding_id: findingId,
          have_baseline_snapshot: !!f.baseline_snapshot,
          have_target_snapshot: !!f.target_snapshot,
          have_baseline_product: !!f.baseline,
          have_target_product: !!f.target,
        },
      );
    }

    // Operator overrides (rare — UI usually omits these)
    const finalMaster = body.mapping_master_sku ?? mappingPayloadInfo.baseline_master_sku;
    const finalBaselineSku = body.mapping_baseline_sku ?? mappingPayloadInfo.baseline_source_sku;
    const finalTargetSku = body.mapping_target_sku ?? mappingPayloadInfo.target_source_sku;

    // Sanity invariant — synthetic fallback should guarantee these
    assertPayloadHasStableKeys({
      ...mappingPayloadInfo,
      baseline_master_sku: finalMaster,
      baseline_source_sku: finalBaselineSku,
      target_source_sku: finalTargetSku,
    });

    // ─── Phase 13B.17 — explicit SELECT → INSERT/UPDATE ─────────────────
    // We previously used .upsert({...}, { onConflict: '...' }) which requires
    // a NON-partial unique index on the conflict columns. Migration 0013 made
    // those indexes partial, so upserts fail with:
    //   "no unique or exclusion constraint matching the ON CONFLICT specification"
    //
    // This route now does an explicit SELECT to find an existing mapping by
    // its stable triple, then UPDATEs or INSERTs accordingly. Works regardless
    // of whether migration 0017 has been applied.

    const mappingPayload = {
      baseline_platform: 'snoonu' as const,
      baseline_master_sku: finalMaster,
      baseline_source_sku: finalBaselineSku,
      baseline_name_snapshot: mappingPayloadInfo.baseline_name_snapshot,
      target_platform: f.target_platform,
      target_source_sku: finalTargetSku,
      target_source_id: mappingPayloadInfo.target_source_id,
      target_name_snapshot: mappingPayloadInfo.target_name_snapshot,
      mapping_type: mappingType,
      confidence: f.confidence ?? null,
      notes: body.notes ?? null,
      created_by: user.id,
    };

    // Look for an existing row that matches either the master-sku triple or
    // the source-sku triple. If we find one, update; otherwise insert.
    let existingId: number | null = null;

    if (finalMaster) {
      const { data: existingByMaster } = await admin
        .from('platform_product_mappings')
        .select('id')
        .eq('target_platform', f.target_platform)
        .eq('target_source_sku', finalTargetSku)
        .eq('baseline_master_sku', finalMaster)
        .maybeSingle();
      if (existingByMaster) existingId = (existingByMaster as { id: number }).id;
    }

    if (!existingId && finalBaselineSku) {
      const { data: existingBySrc } = await admin
        .from('platform_product_mappings')
        .select('id')
        .eq('target_platform', f.target_platform)
        .eq('target_source_sku', finalTargetSku)
        .eq('baseline_source_sku', finalBaselineSku)
        .maybeSingle();
      if (existingBySrc) existingId = (existingBySrc as { id: number }).id;
    }

    if (existingId) {
      // UPDATE — refresh type, confidence, notes, name snapshots
      const { error: updMapErr } = await admin
        .from('platform_product_mappings')
        .update({
          mapping_type: mappingType,
          confidence: f.confidence ?? null,
          notes: body.notes ?? null,
          baseline_name_snapshot: mappingPayloadInfo.baseline_name_snapshot,
          target_name_snapshot: mappingPayloadInfo.target_name_snapshot,
          // Do not overwrite created_by — preserve the original operator
        })
        .eq('id', existingId);
      if (updMapErr) return err('MAPPING_UPDATE_FAILED', updMapErr.message, 500, {
        attempted_payload: mappingPayload,
        existing_id: existingId,
      });
      mappingId = existingId;
    } else {
      // INSERT
      const { data: mapRow, error: mapErr } = await admin
        .from('platform_product_mappings')
        .insert(mappingPayload)
        .select('id')
        .single();
      if (mapErr) return err('MAPPING_INSERT_FAILED', mapErr.message, 500, {
        attempted_payload: mappingPayload,
      });
      mappingId = (mapRow as { id: number }).id;
    }
  }

  // ─── Update the finding ─────────────────────────────────────────────────
  const { error: updErr } = await admin
    .from('reconciliation_findings')
    .update({
      resolution_status: nextResolution,
      resolution_notes: body.notes ?? null,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', findingId);

  if (updErr) return err('FINDING_UPDATE_FAILED', updErr.message, 500);

  return ok({
    finding_id: findingId,
    new_status: nextResolution,
    mapping_id: mappingId,
    mapping_type: mappingType,
    // Debug info for the UI — surfaces the fallback chain that was used
    mapping_resolved_via: mappingPayloadInfo?.resolved_via ?? null,
    mapping_is_synthetic: mappingPayloadInfo?.is_synthetic ?? false,
    mapping_synthetic_sides: mappingPayloadInfo?.synthetic_sides ?? [],
  });
});
