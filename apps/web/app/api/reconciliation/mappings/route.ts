/**
 * GET  /api/reconciliation/mappings
 * POST /api/reconciliation/mappings
 *
 * Persistent operator-confirmed product pairings.
 *
 * GET query params:
 *   ?platform=talabat        - filter by target platform
 *   ?type=confirmed_match    - filter by mapping_type
 *   ?limit=100
 *
 * POST body:
 *   {
 *     target_platform: 'talabat' | 'rafeeq' | 'shopify' | 'internal' | 'other',
 *     target_source_sku: string,
 *     baseline_master_sku?: string,
 *     baseline_source_sku?: string,
 *     baseline_name_snapshot?: string,
 *     target_name_snapshot?: string,
 *     target_source_id?: string,
 *     mapping_type: 'confirmed_match' | 'ignored_pair' | 'manual_link' | 'variant_link',
 *     confidence_at_mapping?: number,
 *     notes?: string,
 *   }
 *
 * Upserts on the SKU-pair index so re-confirming the same pair updates the
 * mapping_type rather than failing.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const PostSchema = z.object({
  target_platform: z.enum(['snoonu', 'talabat', 'rafeeq', 'shopify', 'internal', 'other']),
  target_source_sku: z.string().min(1),
  target_source_id: z.string().optional().nullable(),
  target_name_snapshot: z.string().optional().nullable(),
  baseline_master_sku: z.string().optional().nullable(),
  baseline_source_sku: z.string().optional().nullable(),
  baseline_name_snapshot: z.string().optional().nullable(),
  mapping_type: z.enum(['confirmed_match', 'ignored_pair', 'manual_link', 'variant_link']),
  // Accept both names for backwards compat — canonical column name in 0013 is `confidence`
  confidence: z.number().min(0).max(1).optional().nullable(),
  confidence_at_mapping: z.number().min(0).max(1).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

// ─── GET ────────────────────────────────────────────────────────────────────

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);
  const platform = url.searchParams.get('platform');
  const type = url.searchParams.get('type');
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));

  const admin = createAdminSupabaseClient();
  let q = admin
    .from('platform_product_mappings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (platform) q = q.eq('target_platform', platform);
  if (type) q = q.eq('mapping_type', type);

  const { data } = await q;
  return ok({ mappings: data ?? [] });
});

// ─── POST ───────────────────────────────────────────────────────────────────

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = PostSchema.parse(await req.json());

  if (!body.baseline_master_sku && !body.baseline_source_sku) {
    return err(
      'NEEDS_BASELINE_SKU',
      'Provide either baseline_master_sku or baseline_source_sku',
      400,
    );
  }

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // Phase 13B.17: explicit SELECT → INSERT/UPDATE so we don't depend on
  // a non-partial unique index. See the resolve route for the same pattern.
  const row = {
    baseline_platform: 'snoonu' as const,
    baseline_master_sku: body.baseline_master_sku ?? null,
    baseline_source_sku: body.baseline_source_sku ?? null,
    baseline_name_snapshot: body.baseline_name_snapshot ?? null,
    target_platform: body.target_platform,
    target_source_sku: body.target_source_sku,
    target_source_id: body.target_source_id ?? null,
    target_name_snapshot: body.target_name_snapshot ?? null,
    mapping_type: body.mapping_type,
    confidence: body.confidence ?? body.confidence_at_mapping ?? null,
    notes: body.notes ?? null,
    created_by: user.id,
  };

  let existingId: number | null = null;
  if (body.baseline_master_sku) {
    const { data: existingByMaster } = await admin
      .from('platform_product_mappings')
      .select('id')
      .eq('target_platform', body.target_platform)
      .eq('target_source_sku', body.target_source_sku)
      .eq('baseline_master_sku', body.baseline_master_sku)
      .maybeSingle();
    if (existingByMaster) existingId = (existingByMaster as { id: number }).id;
  }
  if (!existingId && body.baseline_source_sku) {
    const { data: existingBySrc } = await admin
      .from('platform_product_mappings')
      .select('id')
      .eq('target_platform', body.target_platform)
      .eq('target_source_sku', body.target_source_sku)
      .eq('baseline_source_sku', body.baseline_source_sku)
      .maybeSingle();
    if (existingBySrc) existingId = (existingBySrc as { id: number }).id;
  }

  if (existingId) {
    const { data, error } = await admin
      .from('platform_product_mappings')
      .update({
        mapping_type: row.mapping_type,
        confidence: row.confidence,
        notes: row.notes,
        baseline_name_snapshot: row.baseline_name_snapshot,
        target_name_snapshot: row.target_name_snapshot,
      })
      .eq('id', existingId)
      .select('*')
      .single();
    if (error) return err('UPDATE_FAILED', error.message, 500);
    return ok({ mapping: data });
  } else {
    const { data, error } = await admin
      .from('platform_product_mappings')
      .insert(row)
      .select('*')
      .single();
    if (error) return err('INSERT_FAILED', error.message, 500);
    return ok({ mapping: data });
  }
});
