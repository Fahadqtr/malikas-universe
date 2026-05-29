/**
 * Mapping payload builder — Phase 13B fix.
 *
 * Single source of truth for resolving the SKUs/keys needed to insert a
 * `platform_product_mappings` row. Used by:
 *   - /api/reconciliation/findings/[id]/resolve  (Create mapping / Mark matched / Ignore)
 *   - /api/reconciliation/mappings              (direct mapping creation)
 *
 * Fallback chains:
 *
 *   mapping_master_sku:
 *     baseline_snapshot.matched_master_sku
 *     baseline_product.matched_master_sku
 *     target_snapshot.matched_master_sku
 *     target_product.matched_master_sku
 *
 *   mapping_baseline_sku:
 *     baseline_snapshot.source_sku
 *     baseline_product.source_sku
 *     baseline_snapshot.barcode  (prefixed as BARCODE:<value>)
 *     baseline_product.barcode   (prefixed as BARCODE:<value>)
 *     synthetic                  (AUTO::<slug>::<platform>)
 *
 *   mapping_target_sku:
 *     target_snapshot.source_sku
 *     target_product.source_sku
 *     target_snapshot.barcode    (prefixed as BARCODE:<value>)
 *     target_product.barcode     (prefixed as BARCODE:<value>)
 *     synthetic                  (AUTO::<slug>::<platform>)
 *
 * Invariants enforced:
 *   - Returned payload ALWAYS has at least one stable key per side
 *   - If only synthetic SKUs were available, `payload.is_synthetic` is true
 *     and `payload.synthetic_sides` lists which side(s) used the synthetic
 *     fallback so the UI can flag the mapping for review
 *
 * Never throws on missing data — only returns null if BOTH baseline and
 * target are completely empty (no snapshot, no product, no name).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProductLike = {
  id?: number | null;
  source_sku?: string | null;
  matched_master_sku?: string | null;
  barcode?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  normalized_name?: string | null;
  platform?: string | null;
};

export type MappingPayloadInput = {
  baseline_snapshot?: ProductLike | null;
  baseline_product?: ProductLike | null;
  target_snapshot?: ProductLike | null;
  target_product?: ProductLike | null;
  finding_master_sku?: string | null;
  baseline_platform: string;   // usually 'snoonu'
  target_platform: string;
};

export type ResolvedVia =
  | 'baseline_snapshot.matched_master_sku'
  | 'baseline_product.matched_master_sku'
  | 'target_snapshot.matched_master_sku'
  | 'target_product.matched_master_sku'
  | 'finding.master_sku'
  | 'baseline_snapshot.source_sku'
  | 'baseline_product.source_sku'
  | 'target_snapshot.source_sku'
  | 'target_product.source_sku'
  | 'baseline_snapshot.barcode'
  | 'baseline_product.barcode'
  | 'target_snapshot.barcode'
  | 'target_product.barcode'
  | 'synthetic'
  | 'none';

export type MappingPayload = {
  baseline_master_sku: string | null;
  baseline_source_sku: string;
  baseline_name_snapshot: string | null;
  target_source_sku: string;
  target_source_id: string | null;
  target_name_snapshot: string | null;
  is_synthetic: boolean;
  synthetic_sides: Array<'baseline' | 'target'>;
  /** Diagnostics: which source each field was resolved from. */
  resolved_via: {
    master_sku: ResolvedVia;
    baseline_sku: ResolvedVia;
    target_sku: ResolvedVia;
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function pickName(p: ProductLike | null | undefined): string | null {
  if (!p) return null;
  return nonEmpty(p.name_en) ?? nonEmpty(p.name_ar) ?? nonEmpty(p.normalized_name);
}

/**
 * Build a slug-safe identifier for synthetic SKUs.
 * Example: "Urban Decay All Nighter Setting Spray (Mini Size)"
 *        → "urban-decay-all-nighter-setting-spray-mini-size"
 */
function slugifyForSku(name: string | null | undefined, fallback = 'unknown'): string {
  const raw = (name ?? '').toString().trim();
  if (!raw) return fallback;
  const slug = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')                  // strip Latin diacritics
    .replace(/[^a-z0-9\s-]/g, ' ')                     // drop punctuation
    .replace(/\s+/g, '-')                              // spaces → hyphens
    .replace(/-+/g, '-')                               // collapse hyphen runs
    .replace(/^-+|-+$/g, '')                           // trim hyphens
    .slice(0, 80);
  return slug || fallback;
}

/** AUTO::<slug>::<platform> — deterministic, safe to upsert against. */
export function syntheticSku(name: string | null | undefined, platform: string): string {
  return `AUTO::${slugifyForSku(name)}::${platform.toLowerCase().trim() || 'unknown'}`;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve the SKU/key payload needed to insert a platform_product_mapping.
 * Never throws on missing data; falls back to synthetic SKUs derived from
 * normalized product names.
 *
 * Returns `null` only when BOTH sides are completely empty (no snapshot,
 * no product, no name) — in which case there's nothing to map and the
 * caller should surface a clearer "no data on either side" error.
 */
export function buildMappingPayload(input: MappingPayloadInput): MappingPayload | null {
  const bs = input.baseline_snapshot ?? null;
  const bp = input.baseline_product ?? null;
  const ts = input.target_snapshot ?? null;
  const tp = input.target_product ?? null;

  const baselineName = pickName(bs) ?? pickName(bp);
  const targetName = pickName(ts) ?? pickName(tp);

  // If literally nothing is known on EITHER side, there's no mapping to make.
  if (!baselineName && !targetName &&
      !nonEmpty(bs?.source_sku) && !nonEmpty(bp?.source_sku) &&
      !nonEmpty(ts?.source_sku) && !nonEmpty(tp?.source_sku) &&
      !nonEmpty(bs?.barcode) && !nonEmpty(bp?.barcode) &&
      !nonEmpty(ts?.barcode) && !nonEmpty(tp?.barcode) &&
      !nonEmpty(bs?.matched_master_sku) && !nonEmpty(bp?.matched_master_sku) &&
      !nonEmpty(ts?.matched_master_sku) && !nonEmpty(tp?.matched_master_sku) &&
      !nonEmpty(input.finding_master_sku)
  ) {
    return null;
  }

  // ─── master_sku resolution ────────────────────────────────────────────
  let masterSku: string | null = null;
  let masterVia: ResolvedVia = 'none';
  if (nonEmpty(bs?.matched_master_sku)) {
    masterSku = nonEmpty(bs!.matched_master_sku);
    masterVia = 'baseline_snapshot.matched_master_sku';
  } else if (nonEmpty(bp?.matched_master_sku)) {
    masterSku = nonEmpty(bp!.matched_master_sku);
    masterVia = 'baseline_product.matched_master_sku';
  } else if (nonEmpty(ts?.matched_master_sku)) {
    masterSku = nonEmpty(ts!.matched_master_sku);
    masterVia = 'target_snapshot.matched_master_sku';
  } else if (nonEmpty(tp?.matched_master_sku)) {
    masterSku = nonEmpty(tp!.matched_master_sku);
    masterVia = 'target_product.matched_master_sku';
  } else if (nonEmpty(input.finding_master_sku)) {
    masterSku = nonEmpty(input.finding_master_sku);
    masterVia = 'finding.master_sku';
  }

  // ─── baseline_sku resolution ─────────────────────────────────────────
  const baselineRes = resolveSideSku(
    bs, bp, baselineName, input.baseline_platform,
    {
      snapSku: 'baseline_snapshot.source_sku',
      prodSku: 'baseline_product.source_sku',
      snapBar: 'baseline_snapshot.barcode',
      prodBar: 'baseline_product.barcode',
    },
  );

  // ─── target_sku resolution ───────────────────────────────────────────
  const targetRes = resolveSideSku(
    ts, tp, targetName, input.target_platform,
    {
      snapSku: 'target_snapshot.source_sku',
      prodSku: 'target_product.source_sku',
      snapBar: 'target_snapshot.barcode',
      prodBar: 'target_product.barcode',
    },
  );

  const syntheticSides: Array<'baseline' | 'target'> = [];
  if (baselineRes.via === 'synthetic') syntheticSides.push('baseline');
  if (targetRes.via === 'synthetic') syntheticSides.push('target');

  return {
    baseline_master_sku: masterSku,
    baseline_source_sku: baselineRes.sku,
    baseline_name_snapshot: baselineName,
    target_source_sku: targetRes.sku,
    target_source_id:
      nonEmpty((tp as { source_product_id?: string | null })?.source_product_id) ??
      nonEmpty((ts as { source_product_id?: string | null })?.source_product_id) ??
      null,
    target_name_snapshot: targetName,
    is_synthetic: syntheticSides.length > 0,
    synthetic_sides: syntheticSides,
    resolved_via: {
      master_sku: masterVia,
      baseline_sku: baselineRes.via,
      target_sku: targetRes.via,
    },
  };
}

function resolveSideSku(
  snap: ProductLike | null,
  prod: ProductLike | null,
  name: string | null,
  platform: string,
  labels: {
    snapSku: ResolvedVia;
    prodSku: ResolvedVia;
    snapBar: ResolvedVia;
    prodBar: ResolvedVia;
  },
): { sku: string; via: ResolvedVia } {
  if (nonEmpty(snap?.source_sku)) return { sku: nonEmpty(snap!.source_sku)!, via: labels.snapSku };
  if (nonEmpty(prod?.source_sku)) return { sku: nonEmpty(prod!.source_sku)!, via: labels.prodSku };
  if (nonEmpty(snap?.barcode)) return { sku: `BARCODE:${nonEmpty(snap!.barcode)}`, via: labels.snapBar };
  if (nonEmpty(prod?.barcode)) return { sku: `BARCODE:${nonEmpty(prod!.barcode)}`, via: labels.prodBar };
  return { sku: syntheticSku(name, platform), via: 'synthetic' };
}

/**
 * Invariant assertion. Throws if the payload still doesn't have a usable
 * key on each side — should NEVER fire given the synthetic fallback.
 */
export function assertPayloadHasStableKeys(p: MappingPayload): void {
  const baselineKey = p.baseline_master_sku || p.baseline_source_sku;
  const targetKey = p.target_source_sku;
  if (!baselineKey || !targetKey) {
    const err = new Error(
      `MAPPING_PAYLOAD_NO_STABLE_KEY: baseline=${baselineKey ?? 'null'} target=${targetKey ?? 'null'}. ` +
        `This should be impossible — synthetic fallback failed. Payload: ${JSON.stringify(p)}`,
    );
    (err as { code?: string }).code = 'MAPPING_PAYLOAD_NO_STABLE_KEY';
    throw err;
  }
}
