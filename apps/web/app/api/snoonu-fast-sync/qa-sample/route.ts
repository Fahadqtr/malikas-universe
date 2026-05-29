/**
 * GET /api/snoonu-fast-sync/qa-sample
 *
 * Phase 13F.19. Spot-check sampler — pulls auto-applied category mappings
 * from each source and lets the caller review:
 *   - 10 from AI inference round 1 (catalog_source='inferred', older sections)
 *   - 10 from F-2 patch round 2 (catalog_source='inferred', new rule sections)
 *   - 10 from catalog_section_page (overview-scrape)
 *
 * For each sample, re-runs the inferrer to produce the signal + rationale +
 * applies heuristics to flag suspicious mappings (section vs typical product
 * category mismatches).
 *
 * READ-ONLY. No data changes.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { inferCategory, type SnoonuSection } from '@/lib/reconciliation/snoonu-category-inferrer';

export const runtime = 'nodejs';

type Row = {
  id: number;
  snoonu_spi: string | null;
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  brand: string | null;
  price: number | null;
  snoonu_category: string | null;
  catalog_source: string | null;
  catalog_confidence: number | null;
  catalog_checked_at: string | null;
};

// Sections targeted by the F-2 patch (round 2). If a row's category is in
// this set AND catalog_source='inferred', it's likely from the patch.
const ROUND2_SECTIONS: SnoonuSection[] = [
  'Summer And Camping Supplies',
  "Women's Essentials",
  'Beauty Accessories',
];

const SUSPICIOUS_HEURISTICS: Array<{
  test: (r: Row, suggested: SnoonuSection | null) => boolean;
  reason: string;
}> = [
  {
    test: (r, s) => /\b(set|bundle|combo|kit|gift\s*box)\b/i.test(r.name_en ?? '') && s !== 'Beauty Bundle' && s !== 'Gifts & Special Occasions' && s !== 'Eid Specials',
    reason: 'name contains set/bundle/combo/kit but mapped to a non-bundle section',
  },
  {
    test: (r, _s) => /\b(soap)\b/i.test(r.name_en ?? '') && r.snoonu_category === 'Body Care' && /\b(set|bundle|kit)\b/i.test(r.name_en ?? ''),
    reason: 'looks like a "skincare/soap set" — should probably be Beauty Bundle',
  },
  {
    test: (r, _s) => /\bgift\s*set\b/i.test(r.name_en ?? '') && r.snoonu_category !== 'Beauty Bundle' && r.snoonu_category !== 'Gifts & Special Occasions',
    reason: 'name contains "gift set" but not in Beauty Bundle/Gifts section',
  },
  {
    test: (r, s) => /\brhode\b/i.test(r.name_en ?? '') && s !== 'Rhode Products Section',
    reason: 'Rhode brand should always map to Rhode Products Section',
  },
  {
    test: (r, s) => /\blabubu\b|\bla\s*bobo\b/i.test(r.name_en ?? '') && s !== 'Labubu Collection',
    reason: 'Labubu/La Bobo should always map to Labubu Collection',
  },
  {
    test: (r, _s) => r.snoonu_category === 'Face Care' && /\b(shampoo|conditioner|hair\s*oil|hair\s*mask|hair\s*spray)\b/i.test(r.name_en ?? ''),
    reason: 'Hair-product name but mapped to Face Care',
  },
];

function judge(row: Row, suggested: SnoonuSection | null): { ok: boolean; reason: string | null } {
  // Section match check — does the stored category match what the inferrer would predict NOW?
  if (suggested && row.snoonu_category === suggested) {
    return { ok: true, reason: null };
  }

  // Apply suspicious heuristics
  for (const h of SUSPICIOUS_HEURISTICS) {
    if (h.test(row, suggested ?? null)) {
      return { ok: false, reason: h.reason };
    }
  }

  // If inferrer would predict something different but neither flagged, it's "drift"
  if (suggested && row.snoonu_category !== suggested) {
    return { ok: false, reason: `Inferrer now suggests ${suggested} but stored is ${row.snoonu_category}` };
  }

  // Inferrer can't classify it, but a category exists — accept (probably scraped from page)
  return { ok: true, reason: null };
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const admin = createAdminSupabaseClient();

  const selectFields = `id, snoonu_spi, name_en, name_ar, description_en, description_ar, brand, price,
       snoonu_category, catalog_source, catalog_confidence, catalog_checked_at`;

  // ─── Round 2 candidates (most recent inferred, in patch sections) ──────
  const { data: round2Pool, error: r2Err } = await admin
    .from('platform_products')
    .select(selectFields)
    .eq('platform', 'snoonu')
    .not('snoonu_spi', 'is', null)
    .eq('catalog_source', 'inferred')
    .in('snoonu_category', ROUND2_SECTIONS)
    .order('catalog_checked_at', { ascending: false })
    .limit(60);
  if (r2Err) return err('R2_FAILED', r2Err.message, 500);

  // ─── Round 1 candidates (older inferred, NOT in patch sections) ────────
  const { data: round1Pool, error: r1Err } = await admin
    .from('platform_products')
    .select(selectFields)
    .eq('platform', 'snoonu')
    .not('snoonu_spi', 'is', null)
    .eq('catalog_source', 'inferred')
    .not('snoonu_category', 'in', `(${ROUND2_SECTIONS.map((s) => `"${s}"`).join(',')})`)
    .limit(200);
  if (r1Err) return err('R1_FAILED', r1Err.message, 500);

  // ─── catalog_section_page candidates ───────────────────────────────────
  const { data: sectionPool, error: spErr } = await admin
    .from('platform_products')
    .select(selectFields)
    .eq('platform', 'snoonu')
    .eq('catalog_source', 'catalog_section_page')
    .limit(200);
  if (spErr) return err('SP_FAILED', spErr.message, 500);

  // Sample 10 from each pool
  const round1 = shuffle((round1Pool ?? []) as Row[]).slice(0, 10);
  const round2 = shuffle((round2Pool ?? []) as Row[]).slice(0, 10);
  const section = shuffle((sectionPool ?? []) as Row[]).slice(0, 10);

  function analyze(rows: Row[], source_label: string) {
    return rows.map((r) => {
      const hit = inferCategory({
        name_en: r.name_en,
        name_ar: r.name_ar,
        description_en: r.description_en,
        description_ar: r.description_ar,
        brand: r.brand,
        price: r.price,
      });
      const verdict = judge(r, hit?.section ?? null);
      return {
        source: source_label,
        name_en: r.name_en?.slice(0, 70),
        assigned_section: r.snoonu_category,
        catalog_source: r.catalog_source,
        stored_confidence: r.catalog_confidence !== null ? Number(r.catalog_confidence) : null,
        inferrer_now_suggests: hit?.section ?? null,
        inferrer_confidence: hit?.confidence ?? null,
        inferrer_signals: hit?.signals ?? [],
        looks_correct: verdict.ok,
        flag: verdict.reason,
      };
    });
  }

  const samples = [
    ...analyze(round1, 'ai_inference_round_1'),
    ...analyze(round2, 'ai_inference_round_2_patch'),
    ...analyze(section, 'catalog_section_page'),
  ];

  // Counts
  const pass = samples.filter((s) => s.looks_correct).length;
  const fail = samples.filter((s) => !s.looks_correct && /should|wrong|Hair-product/i.test(s.flag ?? '')).length;
  const suspicious = samples.filter((s) => !s.looks_correct && !/should|wrong|Hair-product/i.test(s.flag ?? '')).length;

  // Wrong-mapping examples
  const wrong = samples.filter((s) => !s.looks_correct).slice(0, 10);

  return ok({
    total_sampled: samples.length,
    pass,
    suspicious,
    fail,
    pass_rate_pct: Number(((pass / samples.length) * 100).toFixed(1)),
    samples,
    wrong_or_suspicious: wrong,
  });
});
