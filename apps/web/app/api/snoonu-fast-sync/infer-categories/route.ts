/**
 * POST /api/snoonu-fast-sync/infer-categories
 *
 * Phase 13F.17. Runs deterministic AI-style category inference over every
 * Fast Sync Snoonu row that's still missing snoonu_category. Tiered apply:
 *
 *   ≥ 0.85          → auto-apply: snoonu_category set, catalog_source='inferred_ai',
 *                      catalog_confidence=hit.confidence
 *   0.70–0.84       → save as suggestion (audit_notes), don't write category
 *   < 0.70 / null   → no change, will surface in rebuilt audit queue
 *
 * Body: { dry_run?: boolean } — if true, computes but doesn't write.
 *
 * Returns:
 *   {
 *     total_processed, auto_applied, needs_review, no_match,
 *     distribution: { [section]: count },
 *     auto_apply_examples: top 20 confident mappings,
 *     low_confidence_samples: top 30 below 0.85,
 *     no_match_samples: top 20 with no signal
 *   }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { inferCategory, type InferrerHit, type SnoonuSection } from '@/lib/reconciliation/snoonu-category-inferrer';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({ dry_run: z.boolean().default(false) });

// Extend catalog_source allow list — 'inferred_ai' isn't in migration 0023's CHECK.
// We'll write 'inferred' instead (already allowed since migration 0018), since
// it semantically matches the heuristic-derived classification.

export const POST = withErrorHandling(async (req: NextRequest) => {
  // Owner-only gate FIRST — before body parse, admin client, or any DB work.
  await requireActor(ROLE_SETS.ownerOnly);

  const body = Body.parse(await req.json().catch(() => ({})));
  const admin = createAdminSupabaseClient();

  // ─── 1. Load all Fast Sync rows missing snoonu_category ────────────────
  const candidates: Array<{
    id: number; snoonu_spi: string | null;
    name_en: string | null; name_ar: string | null;
    description_en: string | null; description_ar: string | null;
    brand: string | null; price: number | null;
  }> = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await admin
      .from('platform_products')
      .select('id, snoonu_spi, name_en, name_ar, description_en, description_ar, brand, price')
      .eq('platform', 'snoonu')
      .not('snoonu_spi', 'is', null)
      .is('snoonu_category', null)
      .order('id', { ascending: true })
      .range(offset, offset + 999);
    if (error) {
      console.error(`[infer-categories] load candidates failed (offset=${offset})`, error);
      return err('LOAD_FAILED', 'Internal server error', 500);
    }
    const chunk = (data ?? []) as typeof candidates;
    if (chunk.length === 0) break;
    candidates.push(...chunk);
    if (chunk.length < 1000) break;
  }

  // ─── 2. Run inference on each candidate ────────────────────────────────
  type Tiered = 'auto_apply' | 'needs_review' | 'no_match';
  const results: Array<{
    id: number; spi: string | null; name_en: string | null;
    tier: Tiered; hit: InferrerHit | null;
  }> = [];

  for (const c of candidates) {
    const hit = inferCategory({
      name_en: c.name_en, name_ar: c.name_ar,
      description_en: c.description_en, description_ar: c.description_ar,
      brand: c.brand, price: c.price,
    });
    let tier: Tiered = 'no_match';
    if (hit && hit.confidence >= 0.85) tier = 'auto_apply';
    else if (hit && hit.confidence >= 0.70) tier = 'needs_review';
    results.push({ id: c.id, spi: c.snoonu_spi, name_en: c.name_en, tier, hit });
  }

  // ─── 3. Distribution + samples ─────────────────────────────────────────
  const distribution: Partial<Record<SnoonuSection, number>> = {};
  const autoExamples: Array<Record<string, unknown>> = [];
  const reviewSamples: Array<Record<string, unknown>> = [];
  const noMatchSamples: Array<Record<string, unknown>> = [];

  for (const r of results) {
    if (r.tier === 'auto_apply' && r.hit) {
      distribution[r.hit.section] = (distribution[r.hit.section] ?? 0) + 1;
      if (autoExamples.length < 20) {
        autoExamples.push({
          name_en: r.name_en?.slice(0, 60), section: r.hit.section,
          confidence: r.hit.confidence, signals: r.hit.signals,
        });
      }
    } else if (r.tier === 'needs_review' && r.hit) {
      if (reviewSamples.length < 30) {
        reviewSamples.push({
          name_en: r.name_en?.slice(0, 60), suggested: r.hit.section,
          confidence: r.hit.confidence, signals: r.hit.signals,
        });
      }
    } else if (r.tier === 'no_match') {
      if (noMatchSamples.length < 20) {
        noMatchSamples.push({ name_en: r.name_en?.slice(0, 60), spi: r.spi });
      }
    }
  }

  const totals = {
    total_processed: results.length,
    auto_applied: results.filter((r) => r.tier === 'auto_apply').length,
    needs_review: results.filter((r) => r.tier === 'needs_review').length,
    no_match: results.filter((r) => r.tier === 'no_match').length,
  };

  // ─── 4. Apply the changes (unless dry_run) ─────────────────────────────
  let auto_apply_writes = 0;
  let review_writes = 0;
  if (!body.dry_run) {
    const now = new Date().toISOString();
    const autoList = results.filter((r) => r.tier === 'auto_apply' && r.hit);
    const reviewList = results.filter((r) => r.tier === 'needs_review' && r.hit);

    // Bulk update auto-apply rows. Group by section to minimize round-trips.
    const bySection = new Map<string, number[]>();
    for (const r of autoList) {
      if (!r.hit) continue;
      const arr = bySection.get(r.hit.section) ?? [];
      arr.push(r.id);
      bySection.set(r.hit.section, arr);
    }
    for (const [section, ids] of bySection) {
      const CHUNK = 200;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { error } = await admin
          .from('platform_products')
          .update({
            snoonu_category: section,
            snoonu_menu_path: section,
            catalog_source: 'inferred',
            catalog_confidence: 0.85, // floor — actual hit.confidence is per-row but bulk needs single value
            catalog_checked_at: now,
          })
          .in('id', slice);
        if (!error) auto_apply_writes += slice.length;
      }
    }

    // Mark needs_review rows: write the suggestion to audit_notes-like field
    // platform_products doesn't have a 'category_suggestion' column; we'll
    // create audit rows with reason 'category_suggestion' instead.
    // Use snoonu_browser_audits with audit_status='pending', priority 50,
    // audit_reason='category_suggestion', audit_notes=section name.
    // Skip if an active audit already exists for that product.
    if (reviewList.length > 0) {
      const productIds = reviewList.map((r) => r.id);
      // Load existing active audits
      const { data: existing } = await admin
        .from('snoonu_browser_audits')
        .select('product_id, audit_status')
        .in('product_id', productIds);
      const activeIds = new Set(
        ((existing ?? []) as Array<{ product_id: number; audit_status: string }>)
          .filter((e) => e.audit_status !== 'skipped' && e.audit_status !== 'error')
          .map((e) => e.product_id),
      );

      // Find latest Snoonu import id
      const { data: imp } = await admin
        .from('platform_imports')
        .select('id')
        .eq('platform', 'snoonu')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const importId = (imp as { id: number } | null)?.id;

      if (importId) {
        const toInsert = reviewList
          .filter((r) => !activeIds.has(r.id))
          .map((r) => ({
            product_id: r.id,
            import_id: importId,
            snoonu_spi: r.spi,
            audit_status: 'pending' as const,
            audit_priority: 30,
            audit_reason: 'category_suggestion',
            audit_notes: `AI suggests ${r.hit!.section} (conf ${r.hit!.confidence}). Signals: ${r.hit!.signals.join(', ')}`,
          }));
        const CHUNK = 200;
        for (let i = 0; i < toInsert.length; i += CHUNK) {
          const { error } = await admin.from('snoonu_browser_audits').insert(toInsert.slice(i, i + CHUNK));
          if (!error) review_writes += toInsert.slice(i, i + CHUNK).length;
        }
      }
    }
  }

  return ok({
    dry_run: body.dry_run,
    ...totals,
    auto_apply_writes,
    review_writes,
    distribution,
    auto_apply_examples: autoExamples,
    low_confidence_samples: reviewSamples,
    no_match_samples: noMatchSamples,
  });
});
