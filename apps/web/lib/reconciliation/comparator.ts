/**
 * Snoonu-vs-platform comparator — Phase 13B (smart matching + variants).
 *
 * Three-pass strategy:
 *
 *   PASS 1 — Exact pairing
 *     Pair baseline ⇆ target by stable keys in priority order:
 *       1. matched_master_sku
 *       2. normalized SKU (case + dash insensitive)
 *       3. barcode
 *       4. normalized_name (exact)
 *
 *   PASS 2 — Fuzzy pairing for remaining unpaired
 *     For each unpaired baseline row, score against unpaired target rows by
 *     fuzzy similarity of normalized_name. Tier:
 *       strong (≥0.92)   → treat as paired, emit `possible_match` for review
 *       possible (0.75)  → emit `possible_match` only (don't auto-pair)
 *       low (<0.75)      → leave for missing_on_target
 *
 *   PASS 3 — Variant family scan
 *     Group both sides by (normalized_brand, name_root). Within each family,
 *     compare variant sets. Emit `variant_missing_on_target` /
 *     `variant_missing_on_baseline` for gaps.
 *
 * Persistent mappings:
 *   - `confirmed_match` overrides automated pairing (force-pair).
 *   - `ignored_pair` suppresses all findings for that pair.
 *   - `variant_link` joins a target row to a baseline parent for variant scans.
 *
 * Per-product field diffs (price/name/category/etc.) still run on every paired
 * couple, including pairs created by fuzzy or by mappings.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type PlatformProductRow = {
  id: number;
  platform: string;
  source_sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  category: string | null;
  price: number | null;
  discount_price: number | null;
  stock_quantity: number | null;
  stock_status: string | null;
  platform_status: string | null;
  image_url: string | null;
  image_filename: string | null;
  matched_master_sku: string | null;
  match_status: string | null;
  variants: unknown;
  // Phase 13B fields
  normalized_name: string | null;
  normalized_brand: string | null;
  name_root: string | null;
  name_token_signature: string | null;
  variant_color: string | null;
  variant_shade: string | null;
  variant_size: string | null;
  variant_volume_value: number | null;
  variant_volume_unit: string | null;
  variant_pack: number | null;
  variant_model: string | null;
  variant_type: string | null;
  // Phase 13B.14 — category extraction
  raw_category: string | null;
  raw_subcategory: string | null;
  category_name: string | null;
  subcategory_name: string | null;
  category_confidence: number | null;
  category_source: string | null;
  category_missing: boolean | null;
  // Phase 13E.13 — Snoonu multi-category support
  snoonu_category?: string | null;
  snoonu_secondary_categories?: string[] | null;
};

export type FindingType =
  | 'missing_on_target'
  | 'missing_on_baseline'
  | 'price_mismatch'
  | 'discount_mismatch'
  | 'name_en_mismatch'
  | 'name_ar_mismatch'
  | 'brand_mismatch'
  | 'category_mismatch'
  | 'barcode_mismatch'
  | 'duplicate_on_target'
  | 'stock_mismatch'
  | 'status_mismatch'
  | 'image_filename_mismatch'
  | 'possible_match'
  | 'variant_missing_on_target'
  | 'variant_missing_on_baseline';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

// SuggestedAction is now a re-export from the single source of truth.
// See lib/reconciliation/suggested-actions.ts for the full canonical list
// and the runtime assertion helpers.
import type { SuggestedAction } from './suggested-actions';
export type { SuggestedAction } from './suggested-actions';

export type ProductSnapshot = {
  platform: string;
  product_id: number | null;
  name_en: string | null;
  name_ar: string | null;
  normalized_name: string | null;
  source_sku: string | null;
  matched_master_sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  // Phase 13B.14 — canonical category fields
  category_name: string | null;
  subcategory_name: string | null;
  category_source: string | null;
  category_missing: boolean | null;
  variant_color: string | null;
  variant_size: string | null;
  variant_pack: number | null;
  image_url: string | null;
  image_filename: string | null;
  price: number | null;
  discount_price: number | null;
  stock_quantity: number | null;
  stock_status: string | null;
  platform_status: string | null;
};

export type Finding = {
  master_sku: string | null;
  baseline_product_id: number | null;
  target_product_id: number | null;
  target_platform: string;
  finding_type: FindingType;
  severity: Severity;
  baseline_value: string | null;
  target_value: string | null;
  /** Phase 13B.10: full snapshot of the baseline product. Null only when this finding has no baseline (missing_on_baseline). */
  baseline_snapshot: ProductSnapshot | null;
  /** Phase 13B.10: full snapshot of the target product. Null only when this finding has no target (missing_on_target). */
  target_snapshot: ProductSnapshot | null;
  /** Phase 13B.10: short string explaining why the comparator emitted this finding. */
  matching_reason: string;
  diff_meta: Record<string, unknown>;
  suggested_action: SuggestedAction | null;
  confidence?: number | null;
  candidate_pairs?: Array<{ id: number; score: number; tier: string }> | null;
  differing_tokens?: string[] | null;
  variant_family_id?: string | null;
};

export type MappingRow = {
  baseline_master_sku: string | null;
  baseline_source_sku: string | null;
  target_platform: string;
  target_source_sku: string | null;
  mapping_type: 'confirmed_match' | 'ignored_pair' | 'manual_link' | 'variant_link';
};

// ─── Tunables ───────────────────────────────────────────────────────────────

const PRICE_TOLERANCE = 0.05;
const FUZZY_PAIR_THRESHOLD = 0.92;
const FUZZY_SUGGEST_THRESHOLD = 0.75;

// ─── Imports from sister modules ────────────────────────────────────────────

import { fuzzyCompare } from './fuzzy-match';
import { variantKey, variantLabel, type ExtractedVariantAttrs } from './variant-extractor';
import { normalizeSku } from './text-normalizer';

// ─── Snapshot helpers (Phase 13B.10) ────────────────────────────────────────

/**
 * Freeze the full set of fields we need to render a finding row even when
 * the joined platform_products row is unavailable. Always returns a snapshot
 * unless the input is null/undefined.
 */
export function buildProductSnapshot(r: PlatformProductRow | null | undefined): ProductSnapshot | null {
  if (!r) return null;
  return {
    platform: r.platform,
    product_id: r.id,
    name_en: r.name_en,
    name_ar: r.name_ar,
    normalized_name: r.normalized_name,
    source_sku: r.source_sku,
    matched_master_sku: r.matched_master_sku,
    barcode: r.barcode,
    brand: r.brand,
    category: r.category,
    category_name: r.category_name,
    subcategory_name: r.subcategory_name,
    category_source: r.category_source,
    category_missing: r.category_missing,
    variant_color: r.variant_color,
    variant_size: r.variant_size,
    variant_pack: r.variant_pack,
    image_url: r.image_url,
    image_filename: r.image_filename,
    price: r.price,
    discount_price: r.discount_price,
    stock_quantity: r.stock_quantity,
    stock_status: r.stock_status,
    platform_status: r.platform_status,
  };
}

/**
 * Display-name fallback chain. Never returns null/empty when a snapshot exists.
 *   name_en → name_ar → normalized_name → source_sku → matched_master_sku → barcode → 'Unknown product'
 */
export function snapshotDisplayName(s: ProductSnapshot | null): string {
  if (!s) return 'Unknown product';
  return (
    valOrEmpty(s.name_en) ||
    valOrEmpty(s.name_ar) ||
    valOrEmpty(s.normalized_name) ||
    valOrEmpty(s.source_sku) ||
    valOrEmpty(s.matched_master_sku) ||
    valOrEmpty(s.barcode) ||
    'Unknown product'
  );
}

function valOrEmpty(v: string | null | undefined): string {
  return v && v.trim().length > 0 ? v : '';
}

/**
 * Phase 13B.10 invariant: every emitted Finding carries baseline_snapshot
 * + target_snapshot + matching_reason. This helper fills in safe defaults
 * for any missing optional fields so a Finding can never be incomplete by
 * mistake.
 */
function complete(f: Finding): Finding {
  return {
    ...f,
    candidate_pairs: f.candidate_pairs ?? [],
    differing_tokens: f.differing_tokens ?? [],
    variant_family_id: f.variant_family_id ?? null,
    confidence: f.confidence ?? null,
    diff_meta: f.diff_meta ?? {},
    suggested_action: f.suggested_action ?? 'review_manually',
    // baseline_value / target_value MUST never be empty strings — coerce.
    baseline_value:
      f.baseline_value && f.baseline_value.trim().length > 0
        ? f.baseline_value
        : f.baseline_snapshot
        ? snapshotDisplayName(f.baseline_snapshot)
        : null,
    target_value:
      f.target_value && f.target_value.trim().length > 0
        ? f.target_value
        : f.target_snapshot
        ? snapshotDisplayName(f.target_snapshot)
        : null,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function priceDelta(a: number | null, b: number | null): { abs: number; pct: number } | null {
  if (a == null || b == null) return null;
  if (a === 0 && b === 0) return { abs: 0, pct: 0 };
  const abs = Math.abs(a - b);
  const pct = abs / Math.max(a, b);
  return { abs, pct };
}

function severityFromPct(pct: number): Severity {
  if (pct >= 0.5) return 'critical';
  if (pct >= 0.25) return 'high';
  if (pct >= 0.1) return 'medium';
  return 'low';
}

function stockNumericOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize platform status strings into a coarse bucket. */
function statusBucket(s: string | null): 'active' | 'inactive' | 'draft' | 'unknown' {
  if (!s) return 'unknown';
  const v = s.toLowerCase().trim();
  if (['active', 'published', 'live', 'enabled', 'visible', '1', 'true'].includes(v)) return 'active';
  if (['draft', 'pending', 'pending_approval'].includes(v)) return 'draft';
  if (['inactive', 'archived', 'disabled', 'unpublished', 'blocked', '0', 'false'].includes(v))
    return 'inactive';
  return 'unknown';
}

/** Normalize stock-status strings into a coarse bucket. */
function stockBucket(s: string | null, qty: number | null): 'in_stock' | 'out_of_stock' | 'low_stock' | 'unknown' {
  if (qty != null) {
    if (qty <= 0) return 'out_of_stock';
    if (qty < 5) return 'low_stock';
    return 'in_stock';
  }
  if (!s) return 'unknown';
  const v = s.toLowerCase().trim();
  if (/(in[\s_-]?stock|available|true|1)/.test(v)) return 'in_stock';
  if (/(out[\s_-]?of[\s_-]?stock|unavailable|false|0|oos)/.test(v)) return 'out_of_stock';
  if (/low/.test(v)) return 'low_stock';
  return 'unknown';
}

/** Build the strongest stable key for exact pairing. */
function exactKeyFor(p: PlatformProductRow): string | null {
  if (p.matched_master_sku) return `master:${p.matched_master_sku.toUpperCase()}`;
  const sku = normalizeSku(p.source_sku);
  if (sku) return `sku:${sku}`;
  if (p.barcode) return `barcode:${p.barcode.trim()}`;
  if (p.normalized_name) return `nname:${p.normalized_name}`;
  return null;
}

/** Mapping lookup keys. Build BOTH so a target row can be matched by either. */
function mappingLookupKey(target: PlatformProductRow, baseline_master_sku?: string | null, baseline_source_sku?: string | null): string[] {
  const out: string[] = [];
  const tSku = target.source_sku ? target.source_sku.toUpperCase().trim() : null;
  if (tSku && baseline_master_sku) out.push(`mst|${target.platform}|${tSku}|${baseline_master_sku.toUpperCase()}`);
  if (tSku && baseline_source_sku) out.push(`src|${target.platform}|${tSku}|${baseline_source_sku.toUpperCase()}`);
  return out;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export type CompareInput = {
  target_platform: string;
  baseline_rows: PlatformProductRow[];
  target_rows: PlatformProductRow[];
  mappings: MappingRow[];
};

export type CompareResult = {
  findings: Finding[];
  summary: {
    baseline_total: number;
    target_total: number;
    paired_exact: number;
    paired_fuzzy: number;
    only_on_baseline: number;
    only_on_target: number;
    variant_families_examined: number;
    by_type: Record<FindingType, number>;
    suppressed_by_mapping: number;
  };
};

export function compareSnoonuVsTarget(input: CompareInput): CompareResult {
  const findings: Finding[] = [];
  let suppressed = 0;

  // ─── 1. Mapping index ─────────────────────────────────────────────────────
  // Build two flat sets keyed by (target_platform | target_sku | baseline_*).
  const ignoreSet = new Set<string>();
  const forceMatchSet = new Set<string>();
  for (const m of input.mappings) {
    if (m.target_platform !== input.target_platform) continue;
    const tSku = m.target_source_sku ? m.target_source_sku.toUpperCase() : null;
    if (!tSku) continue;
    if (m.baseline_master_sku) {
      const k = `mst|${m.target_platform}|${tSku}|${m.baseline_master_sku.toUpperCase()}`;
      if (m.mapping_type === 'ignored_pair') ignoreSet.add(k);
      if (m.mapping_type === 'confirmed_match') forceMatchSet.add(k);
    }
    if (m.baseline_source_sku) {
      const k = `src|${m.target_platform}|${tSku}|${m.baseline_source_sku.toUpperCase()}`;
      if (m.mapping_type === 'ignored_pair') ignoreSet.add(k);
      if (m.mapping_type === 'confirmed_match') forceMatchSet.add(k);
    }
  }

  function isPairIgnored(b: PlatformProductRow, t: PlatformProductRow): boolean {
    const ks = mappingLookupKey(t, b.matched_master_sku, b.source_sku);
    return ks.some((k) => ignoreSet.has(k));
  }
  function isPairForced(b: PlatformProductRow, t: PlatformProductRow): boolean {
    const ks = mappingLookupKey(t, b.matched_master_sku, b.source_sku);
    return ks.some((k) => forceMatchSet.has(k));
  }

  // ─── 2. Exact-key index (Pass 1) ──────────────────────────────────────────
  const baselineByKey = new Map<string, PlatformProductRow>();
  for (const b of input.baseline_rows) {
    const k = exactKeyFor(b);
    if (k && !baselineByKey.has(k)) baselineByKey.set(k, b);
  }
  const targetByKey = new Map<string, PlatformProductRow[]>();
  for (const t of input.target_rows) {
    const k = exactKeyFor(t);
    if (!k) continue;
    if (!targetByKey.has(k)) targetByKey.set(k, []);
    targetByKey.get(k)!.push(t);
  }

  const pairedBaselineIds = new Set<number>();
  const pairedTargetIds = new Set<number>();

  let pairedExact = 0;

  for (const [key, b] of baselineByKey) {
    const targets = targetByKey.get(key);
    if (!targets || targets.length === 0) continue;
    const baseSnap = buildProductSnapshot(b);
    if (targets.length > 1) {
      const tSnap = buildProductSnapshot(targets[0]);
      findings.push(complete({
        master_sku: b.matched_master_sku,
        baseline_product_id: b.id,
        target_product_id: targets[0]!.id,
        target_platform: input.target_platform,
        finding_type: 'duplicate_on_target',
        severity: 'medium',
        baseline_value: snapshotDisplayName(baseSnap),
        target_value: `${targets.length} rows`,
        baseline_snapshot: baseSnap,
        target_snapshot: tSnap,
        matching_reason: `duplicate_on_target:${targets.length}_matches_on_key:${key}`,
        diff_meta: { target_ids: targets.map((x) => x.id), key },
        suggested_action: 'review_manually',
      }));
    }
    const t = targets[0]!;
    if (isPairIgnored(b, t)) {
      suppressed++;
      pairedBaselineIds.add(b.id);
      pairedTargetIds.add(t.id);
      continue;
    }
    pairedBaselineIds.add(b.id);
    pairedTargetIds.add(t.id);
    pairedExact++;
    diffOneProduct(b, t, input.target_platform, findings);
  }

  // ─── 3. Force-match from confirmed_match mappings (Pass 1.5) ──────────────
  // If the operator already said "Talabat #123 = Snoonu MK-SKIN-0001", honor it
  // even though exact pairing didn't catch it.
  if (forceMatchSet.size > 0) {
    const targetsBySku = new Map<string, PlatformProductRow[]>();
    for (const t of input.target_rows) {
      if (!t.source_sku) continue;
      const k = t.source_sku.toUpperCase().trim();
      if (!targetsBySku.has(k)) targetsBySku.set(k, []);
      targetsBySku.get(k)!.push(t);
    }
    for (const b of input.baseline_rows) {
      if (pairedBaselineIds.has(b.id)) continue;
      for (const t of input.target_rows) {
        if (pairedTargetIds.has(t.id)) continue;
        if (!isPairForced(b, t)) continue;
        pairedBaselineIds.add(b.id);
        pairedTargetIds.add(t.id);
        pairedExact++;
        diffOneProduct(b, t, input.target_platform, findings);
        break;
      }
    }
    void targetsBySku;
  }

  // ─── 4. Fuzzy pass — match unpaired baseline → unpaired target (Pass 2) ──
  let pairedFuzzy = 0;
  const unpairedTargets = input.target_rows.filter((t) => !pairedTargetIds.has(t.id));

  for (const b of input.baseline_rows) {
    if (pairedBaselineIds.has(b.id)) continue;
    if (!b.normalized_name) continue;

    // Cheap pre-filter: only score targets that share the same brand
    const brandCandidates = unpairedTargets.filter(
      (t) =>
        !pairedTargetIds.has(t.id) &&
        t.normalized_name &&
        (!b.normalized_brand || !t.normalized_brand || t.normalized_brand === b.normalized_brand),
    );

    // Score all (or up to 200 — cap for safety)
    const haystack = brandCandidates.slice(0, 200);
    let best: { row: PlatformProductRow; score: number; diff: string[] } | null = null;
    const candidates: Array<{ id: number; score: number; tier: string }> = [];

    for (const t of haystack) {
      const cmp = fuzzyCompare(b.normalized_name, t.normalized_name!);
      if (cmp.score < FUZZY_SUGGEST_THRESHOLD) continue;
      candidates.push({ id: t.id, score: Number(cmp.score.toFixed(3)), tier: cmp.tier });
      if (!best || cmp.score > best.score) {
        best = { row: t, score: cmp.score, diff: cmp.differing_tokens };
      }
    }

    candidates.sort((a, b2) => b2.score - a.score);
    const topCandidates = candidates.slice(0, 3);

    if (!best) continue;

    const baseSnap = buildProductSnapshot(b);
    const tgtSnap = buildProductSnapshot(best.row);

    if (best.score >= FUZZY_PAIR_THRESHOLD) {
      // Treat as paired. Still emit possible_match so operator can confirm.
      pairedBaselineIds.add(b.id);
      pairedTargetIds.add(best.row.id);
      pairedFuzzy++;
      findings.push(complete({
        master_sku: b.matched_master_sku,
        baseline_product_id: b.id,
        target_product_id: best.row.id,
        target_platform: input.target_platform,
        finding_type: 'possible_match',
        severity: 'low',
        baseline_value: snapshotDisplayName(baseSnap),
        target_value: snapshotDisplayName(tgtSnap),
        baseline_snapshot: baseSnap,
        target_snapshot: tgtSnap,
        matching_reason: `fuzzy_strong:${best.score.toFixed(3)}`,
        diff_meta: { reason: 'fuzzy_strong', pair_threshold: FUZZY_PAIR_THRESHOLD },
        suggested_action: 'confirm_match',
        confidence: Number(best.score.toFixed(3)),
        candidate_pairs: topCandidates,
        differing_tokens: best.diff,
      }));
      diffOneProduct(b, best.row, input.target_platform, findings);
    } else {
      // 0.75..0.92 — show as suggestion only, don't auto-pair
      findings.push(complete({
        master_sku: b.matched_master_sku,
        baseline_product_id: b.id,
        target_product_id: best.row.id,
        target_platform: input.target_platform,
        finding_type: 'possible_match',
        severity: 'medium',
        baseline_value: snapshotDisplayName(baseSnap),
        target_value: snapshotDisplayName(tgtSnap),
        baseline_snapshot: baseSnap,
        target_snapshot: tgtSnap,
        matching_reason: `fuzzy_possible:${best.score.toFixed(3)}`,
        diff_meta: { reason: 'fuzzy_possible' },
        suggested_action: 'review_manually',
        confidence: Number(best.score.toFixed(3)),
        candidate_pairs: topCandidates,
        differing_tokens: best.diff,
      }));
    }
  }

  // ─── 5. Missing-on-target / missing-on-baseline (Pass 2 cleanup) ──────────
  let onlyOnBaseline = 0;
  let onlyOnTarget = 0;
  for (const b of input.baseline_rows) {
    if (pairedBaselineIds.has(b.id)) continue;
    // After fuzzy pass, an unpaired baseline row may already have emitted a
    // `possible_match` finding. If so, don't ALSO emit missing_on_target.
    const hasPossible = findings.some(
      (f) => f.baseline_product_id === b.id && f.finding_type === 'possible_match',
    );
    if (hasPossible) continue;

    onlyOnBaseline++;
    const baseSnap = buildProductSnapshot(b);
    findings.push(complete({
      master_sku: b.matched_master_sku,
      baseline_product_id: b.id,
      target_product_id: null,
      target_platform: input.target_platform,
      finding_type: 'missing_on_target',
      severity: 'high',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: null,
      baseline_snapshot: baseSnap,
      target_snapshot: null,
      matching_reason: 'no_target_match_after_fuzzy_pass',
      diff_meta: { searched_against: input.target_rows.length },
      suggested_action: 'add_to_target',
    }));
  }
  for (const t of input.target_rows) {
    if (pairedTargetIds.has(t.id)) continue;
    const hasPossible = findings.some(
      (f) => f.target_product_id === t.id && f.finding_type === 'possible_match',
    );
    if (hasPossible) continue;
    onlyOnTarget++;
    const tgtSnap = buildProductSnapshot(t);
    findings.push(complete({
      master_sku: t.matched_master_sku,
      baseline_product_id: null,
      target_product_id: t.id,
      target_platform: input.target_platform,
      finding_type: 'missing_on_baseline',
      severity: 'medium',
      baseline_value: null,
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: null,
      target_snapshot: tgtSnap,
      matching_reason: 'no_baseline_match_after_fuzzy_pass',
      diff_meta: { searched_against: input.baseline_rows.length },
      suggested_action: 'review_manually',
    }));
  }

  // ─── 6. Variant family scan (Pass 3) ──────────────────────────────────────
  let variantFamiliesExamined = 0;
  const variantFindings = scanVariantFamilies(
    input.baseline_rows,
    input.target_rows,
    input.target_platform,
  );
  findings.push(...variantFindings.findings);
  variantFamiliesExamined = variantFindings.families;

  // ─── 7. Summary ───────────────────────────────────────────────────────────
  const byType = findings.reduce<Record<FindingType, number>>((acc, f) => {
    acc[f.finding_type] = (acc[f.finding_type] ?? 0) + 1;
    return acc;
  }, {} as Record<FindingType, number>);

  return {
    findings,
    summary: {
      baseline_total: input.baseline_rows.length,
      target_total: input.target_rows.length,
      paired_exact: pairedExact,
      paired_fuzzy: pairedFuzzy,
      only_on_baseline: onlyOnBaseline,
      only_on_target: onlyOnTarget,
      variant_families_examined: variantFamiliesExamined,
      by_type: byType,
      suppressed_by_mapping: suppressed,
    },
  };
}

// ─── Per-product field diff ─────────────────────────────────────────────────

function diffOneProduct(
  b: PlatformProductRow,
  t: PlatformProductRow,
  targetPlatform: string,
  out: Finding[],
): void {
  const masterSku = b.matched_master_sku ?? t.matched_master_sku ?? null;
  const baseSnap = buildProductSnapshot(b);
  const tgtSnap = buildProductSnapshot(t);

  // Name (EN) — only flag when fuzzy difference is meaningful
  if (b.normalized_name && t.normalized_name && b.normalized_name !== t.normalized_name) {
    const cmp = fuzzyCompare(b.normalized_name, t.normalized_name);
    if (cmp.score < 0.92) {
      out.push(complete({
        master_sku: masterSku,
        baseline_product_id: b.id,
        target_product_id: t.id,
        target_platform: targetPlatform,
        finding_type: 'name_en_mismatch',
        severity: cmp.score < 0.75 ? 'medium' : 'low',
        baseline_value: snapshotDisplayName(baseSnap),
        target_value: snapshotDisplayName(tgtSnap),
        baseline_snapshot: baseSnap,
        target_snapshot: tgtSnap,
        matching_reason: `name_en_fuzzy:${cmp.score.toFixed(3)}`,
        diff_meta: { score: cmp.score },
        differing_tokens: cmp.differing_tokens,
        suggested_action: 'update_target_name',
        confidence: Number(cmp.score.toFixed(3)),
      }));
    }
  }

  // Name (AR)
  if (b.name_ar && t.name_ar && b.name_ar.trim() !== t.name_ar.trim()) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'name_ar_mismatch',
      severity: 'low',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: 'name_ar_differs',
      diff_meta: { baseline_ar: b.name_ar, target_ar: t.name_ar },
      suggested_action: 'update_target_name',
    }));
  }

  // Brand
  if (
    b.normalized_brand &&
    t.normalized_brand &&
    b.normalized_brand !== t.normalized_brand
  ) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'brand_mismatch',
      severity: 'medium',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: 'brand_differs',
      diff_meta: { baseline_brand: b.brand, target_brand: t.brand },
      suggested_action: 'review_manually',
    }));
  }

  // Category — Phase 13E.15
  // Rule: Snoonu is the source of truth AND can list a product in multiple
  // categories simultaneously. A category match passes if the target category
  // matches the Snoonu PRIMARY category OR ANY of its secondary categories.
  // Only flag category_mismatch when the target value is not in the full set.
  const targetCat = (t.category_name ?? '').toLowerCase().trim();
  const targetHasCategory = targetCat.length > 0;

  // Build the full Snoonu category set: primary + secondary list
  const baselineCategories = new Set<string>();
  const primary = (b.snoonu_category ?? b.category_name ?? '').toLowerCase().trim();
  if (primary) baselineCategories.add(primary);
  for (const sec of b.snoonu_secondary_categories ?? []) {
    const k = sec.toLowerCase().trim();
    if (k) baselineCategories.add(k);
  }

  const baselineHasCategory = baselineCategories.size > 0 && !b.category_missing;

  if (baselineHasCategory && targetHasCategory && !baselineCategories.has(targetCat)) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'category_mismatch',
      severity: 'low',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: baselineCategories.size > 1
        ? 'category_not_in_multi_listing'
        : 'category_name_differs',
      diff_meta: {
        baseline_categories: [...baselineCategories],
        target_category: t.category_name,
        baseline_raw: b.raw_category,
        target_raw: t.raw_category,
        baseline_source: b.category_source,
        target_source: t.category_source,
        snoonu_is_multi_listed: baselineCategories.size > 1,
      },
      suggested_action: 'update_target_category',
    }));
  }

  // Price
  const priceDiff = priceDelta(b.price, t.price);
  if (priceDiff && priceDiff.pct > PRICE_TOLERANCE) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'price_mismatch',
      severity: severityFromPct(priceDiff.pct),
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: `price_diff_pct:${priceDiff.pct.toFixed(3)}`,
      diff_meta: { abs_diff: priceDiff.abs, pct_diff: priceDiff.pct, baseline_price: b.price, target_price: t.price },
      suggested_action: 'update_target_price',
    }));
  }

  // Discount price
  const bDisc = b.discount_price != null;
  const tDisc = t.discount_price != null;
  if (bDisc !== tDisc) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'discount_mismatch',
      severity: 'medium',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: 'discount_presence_differs',
      diff_meta: { baseline_has: bDisc, target_has: tDisc, baseline_discount: b.discount_price, target_discount: t.discount_price },
      suggested_action: 'update_target_price',
    }));
  } else if (bDisc && tDisc) {
    const dd = priceDelta(b.discount_price, t.discount_price);
    if (dd && dd.pct > PRICE_TOLERANCE) {
      out.push(complete({
        master_sku: masterSku,
        baseline_product_id: b.id,
        target_product_id: t.id,
        target_platform: targetPlatform,
        finding_type: 'discount_mismatch',
        severity: severityFromPct(dd.pct),
        baseline_value: snapshotDisplayName(baseSnap),
        target_value: snapshotDisplayName(tgtSnap),
        baseline_snapshot: baseSnap,
        target_snapshot: tgtSnap,
        matching_reason: `discount_diff_pct:${dd.pct.toFixed(3)}`,
        diff_meta: { abs_diff: dd.abs, pct_diff: dd.pct, baseline_discount: b.discount_price, target_discount: t.discount_price },
        suggested_action: 'update_target_price',
      }));
    }
  }

  // Barcode
  if (b.barcode && t.barcode && b.barcode.trim() !== t.barcode.trim()) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'barcode_mismatch',
      severity: 'high',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: 'barcode_differs',
      diff_meta: { baseline_barcode: b.barcode, target_barcode: t.barcode },
      suggested_action: 'review_manually',
    }));
  }

  // Status (active/inactive/draft)
  const bStatus = statusBucket(b.platform_status);
  const tStatus = statusBucket(t.platform_status);
  if (bStatus !== 'unknown' && tStatus !== 'unknown' && bStatus !== tStatus) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'status_mismatch',
      severity: bStatus === 'active' && tStatus !== 'active' ? 'high' : 'medium',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: `status_bucket_diff:${bStatus}_vs_${tStatus}`,
      diff_meta: { baseline_bucket: bStatus, target_bucket: tStatus, baseline_status: b.platform_status, target_status: t.platform_status },
      suggested_action:
        bStatus === 'active' && tStatus !== 'active'
          ? 'activate_on_target'
          : bStatus !== 'active' && tStatus === 'active'
          ? 'deactivate_on_target'
          : 'review_manually',
    }));
  }

  // Stock
  const bStock = stockBucket(b.stock_status, stockNumericOrNull(b.stock_quantity));
  const tStock = stockBucket(t.stock_status, stockNumericOrNull(t.stock_quantity));
  if (bStock !== 'unknown' && tStock !== 'unknown' && bStock !== tStock) {
    out.push(complete({
      master_sku: masterSku,
      baseline_product_id: b.id,
      target_product_id: t.id,
      target_platform: targetPlatform,
      finding_type: 'stock_mismatch',
      severity: bStock === 'out_of_stock' || tStock === 'out_of_stock' ? 'high' : 'medium',
      baseline_value: snapshotDisplayName(baseSnap),
      target_value: snapshotDisplayName(tgtSnap),
      baseline_snapshot: baseSnap,
      target_snapshot: tgtSnap,
      matching_reason: `stock_bucket_diff:${bStock}_vs_${tStock}`,
      diff_meta: {
        baseline_bucket: bStock,
        target_bucket: tStock,
        baseline_qty: b.stock_quantity,
        target_qty: t.stock_quantity,
      },
      suggested_action:
        bStock === 'out_of_stock' && tStock === 'in_stock'
          ? 'mark_oos_on_target'
          : 'review_manually',
    }));
  }

  // Image filename mismatch (cheap check — same filename across platforms)
  if (b.image_filename && t.image_filename) {
    const bFile = b.image_filename.toLowerCase();
    const tFile = t.image_filename.toLowerCase();
    if (bFile !== tFile) {
      out.push(complete({
        master_sku: masterSku,
        baseline_product_id: b.id,
        target_product_id: t.id,
        target_platform: targetPlatform,
        finding_type: 'image_filename_mismatch',
        severity: 'low',
        baseline_value: snapshotDisplayName(baseSnap),
        target_value: snapshotDisplayName(tgtSnap),
        baseline_snapshot: baseSnap,
        target_snapshot: tgtSnap,
        matching_reason: 'image_filename_differs',
        diff_meta: { baseline_filename: b.image_filename, target_filename: t.image_filename },
        suggested_action: 'use_snoonu_image',
      }));
    }
  }
}

// ─── Variant family scan ────────────────────────────────────────────────────

function scanVariantFamilies(
  baseline: PlatformProductRow[],
  target: PlatformProductRow[],
  targetPlatform: string,
): { findings: Finding[]; families: number } {
  const findings: Finding[] = [];

  // Group by (normalized_brand, name_root). Skip rows missing both.
  const baselineFamilies = groupByFamily(baseline);
  const targetFamilies = groupByFamily(target);

  const allKeys = new Set<string>([...baselineFamilies.keys(), ...targetFamilies.keys()]);
  let families = 0;

  for (const key of allKeys) {
    const bs = baselineFamilies.get(key) ?? [];
    const ts = targetFamilies.get(key) ?? [];
    // Only meaningful if at least one side has >1 variant
    if (bs.length + ts.length < 2) continue;
    if (bs.length === 0 || ts.length === 0) continue; // covered by missing_on_*
    families++;

    const bMap = new Map<string, PlatformProductRow>();
    const tMap = new Map<string, PlatformProductRow>();
    for (const r of bs) bMap.set(rowVariantKey(r), r);
    for (const r of ts) tMap.set(rowVariantKey(r), r);

    // Variant present on baseline but not target
    for (const [vk, b] of bMap) {
      if (!tMap.has(vk)) {
        const baseSnap = buildProductSnapshot(b);
        findings.push(complete({
          master_sku: b.matched_master_sku,
          baseline_product_id: b.id,
          target_product_id: null,
          target_platform: targetPlatform,
          finding_type: 'variant_missing_on_target',
          severity: 'high',
          baseline_value: `${snapshotDisplayName(baseSnap)} — ${variantLabel(rowVariantAttrs(b))}`,
          target_value: null,
          baseline_snapshot: baseSnap,
          target_snapshot: null,
          matching_reason: `variant_family_missing_on_target:${vk}`,
          diff_meta: { family_key: key, variant_key: vk },
          suggested_action: 'add_to_target',
          variant_family_id: key,
        }));
      }
    }
    // Variant present on target but not baseline (less critical — target has a variant we didn't approve)
    for (const [vk, t] of tMap) {
      if (!bMap.has(vk)) {
        const tgtSnap = buildProductSnapshot(t);
        findings.push(complete({
          master_sku: t.matched_master_sku,
          baseline_product_id: null,
          target_product_id: t.id,
          target_platform: targetPlatform,
          finding_type: 'variant_missing_on_baseline',
          severity: 'medium',
          baseline_value: null,
          target_value: `${snapshotDisplayName(tgtSnap)} — ${variantLabel(rowVariantAttrs(t))}`,
          baseline_snapshot: null,
          target_snapshot: tgtSnap,
          matching_reason: `variant_family_missing_on_baseline:${vk}`,
          diff_meta: { family_key: key, variant_key: vk },
          suggested_action: 'review_manually',
          variant_family_id: key,
        }));
      }
    }
  }

  return { findings, families };
}

function groupByFamily(rows: PlatformProductRow[]): Map<string, PlatformProductRow[]> {
  const m = new Map<string, PlatformProductRow[]>();
  for (const r of rows) {
    if (!r.name_root) continue;
    const brand = r.normalized_brand ?? 'unknown';
    const key = `${brand}|${r.name_root}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(r);
  }
  return m;
}

function rowVariantAttrs(r: PlatformProductRow): ExtractedVariantAttrs {
  return {
    variant_color: r.variant_color,
    variant_shade: r.variant_shade,
    variant_size: r.variant_size,
    variant_volume_value: r.variant_volume_value,
    variant_volume_unit: r.variant_volume_unit,
    variant_pack: r.variant_pack,
    variant_model: r.variant_model,
    variant_type: r.variant_type,
    extracted_tokens: [],
  };
}

function rowVariantKey(r: PlatformProductRow): string {
  return variantKey(rowVariantAttrs(r));
}
