/**
 * Snoonu Catalog Section PAGE Matcher — Phase 13F.5.
 *
 * Different from Phase 13D.8's `snoonu-section-matcher.ts`:
 *   - 13D.8 = heuristic matcher (category rules → section name)
 *   - 13F.5 = page-scrape matcher: given the actual list of products that
 *             appear on a Snoonu catalog section page, resolve each one to
 *             a platform_products row by SPI / normalized_name / fuzzy.
 *
 * Resolution priority (per scraped row):
 *   1. snoonu_spi exact            → confidence 1.00
 *   2. source_product_id exact     → confidence 0.98
 *   3. normalized_name exact       → confidence 0.92
 *   4. fuzzy (Jaccard ≥ threshold) → confidence = similarity
 *   5. no_match                    → confidence 0
 *
 * READ-ONLY. No DB writes here.
 */

import { normalizeProductName } from './text-normalizer';

// ─── Types ─────────────────────────────────────────────────────────────────

export type ScrapedProduct = {
  /** SPI if it was visible in the section page DOM */
  spi: string | null;
  /** Product name as it appeared on the section page */
  name: string;
  price?: number | null;
  image_url?: string | null;
};

export type CandidateProduct = {
  id: number;
  snoonu_spi: string | null;
  source_product_id: string | null;
  normalized_name: string | null;
  name_en: string | null;
  price: number | null;
  snoonu_category: string | null;
  snoonu_secondary_categories: string[] | null;
};

export type PageMatchResult = {
  scraped: ScrapedProduct;
  product_id: number | null;
  match_method: 'spi' | 'normalized_name' | 'fuzzy_name' | 'no_match';
  match_confidence: number; // 0.00–1.00
  candidate: CandidateProduct | null;
};

// ─── Similarity (Jaccard on tokens — same trick as the comparator) ────────

function tokenSet(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter((t) => t.length >= 2));
}

function jaccard(a: string, b: string): number {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return inter / union;
}

// ─── Indexes for fast match ───────────────────────────────────────────────

export function buildCandidateIndexes(candidates: CandidateProduct[]) {
  const bySpi = new Map<string, CandidateProduct>();
  const bySourceId = new Map<string, CandidateProduct>();
  const byNormName = new Map<string, CandidateProduct>();
  for (const c of candidates) {
    if (c.snoonu_spi) bySpi.set(c.snoonu_spi, c);
    if (c.source_product_id) bySourceId.set(c.source_product_id, c);
    if (c.normalized_name && !byNormName.has(c.normalized_name)) {
      byNormName.set(c.normalized_name, c);
    }
  }
  return { bySpi, bySourceId, byNormName };
}

// ─── Main matcher ─────────────────────────────────────────────────────────

export function matchScrapedProduct(
  scraped: ScrapedProduct,
  candidates: CandidateProduct[],
  indexes: ReturnType<typeof buildCandidateIndexes>,
  options: { fuzzyThreshold?: number } = {},
): PageMatchResult {
  const fuzzyThreshold = options.fuzzyThreshold ?? 0.8;

  // 1. SPI exact (via either snoonu_spi or source_product_id)
  if (scraped.spi) {
    const hit = indexes.bySpi.get(scraped.spi) ?? indexes.bySourceId.get(scraped.spi);
    if (hit) {
      return {
        scraped,
        product_id: hit.id,
        match_method: 'spi',
        match_confidence: 1.0,
        candidate: hit,
      };
    }
  }

  // 2. Normalized-name exact
  const norm = normalizeProductName(scraped.name).normalized_name;
  if (norm) {
    const hit = indexes.byNormName.get(norm);
    if (hit) {
      return {
        scraped,
        product_id: hit.id,
        match_method: 'normalized_name',
        match_confidence: 0.92,
        candidate: hit,
      };
    }

    // 3. Fuzzy fallback over normalized_name candidates
    let best: CandidateProduct | null = null;
    let bestSim = 0;
    for (const c of candidates) {
      if (!c.normalized_name) continue;
      const sim = jaccard(norm, c.normalized_name);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= fuzzyThreshold) {
      return {
        scraped,
        product_id: best.id,
        match_method: 'fuzzy_name',
        match_confidence: Number(bestSim.toFixed(2)),
        candidate: best,
      };
    }
  }

  return {
    scraped,
    product_id: null,
    match_method: 'no_match',
    match_confidence: 0,
    candidate: null,
  };
}

// ─── Section reconciliation (primary vs secondary) ─────────────────────────

/**
 * Given a product that already has a snoonu_category and is observed in one
 * or more sections, decide which becomes primary.
 *
 * Rules:
 *   - If the current primary is included in the new observed sections, keep
 *     it (stable — avoids primary churn on re-scrape).
 *   - Otherwise the first observed section becomes primary.
 *   - All other observed sections go to secondary[].
 *   - Existing secondaries that are NOT in the observed list are dropped
 *     (they represent stale state — re-scrape is the source of truth).
 */
export function reconcileSections(
  current_primary: string | null,
  observed_sections: string[],
): { primary: string | null; secondary: string[] } {
  const unique = Array.from(new Set(observed_sections.filter(Boolean)));
  if (unique.length === 0) return { primary: current_primary, secondary: [] };

  if (current_primary && unique.includes(current_primary)) {
    return {
      primary: current_primary,
      secondary: unique.filter((s) => s !== current_primary),
    };
  }
  const [first, ...rest] = unique;
  return { primary: first ?? null, secondary: rest };
}
