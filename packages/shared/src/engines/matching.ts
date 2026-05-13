/**
 * MATCHING ENGINE — cross-platform fuzzy match with confidence scoring.
 */
import { normalizeForMatching, stripMarketingNoise } from './cleaning';
import { similarity } from '../utils/strings';

export type MatchableProduct = {
  master_sku?: string | null;
  snoonu_sku?: string | null;
  barcode?: string | null;
  brand_name?: string | null;
  product_name_en: string;
  product_name_ar?: string | null;
  size?: string | null;
  variant?: string | null;
  color?: string | null;
  price?: number | null;
  image_phash?: string | null;
};

export type MatchTier = 'exact' | 'high' | 'medium' | 'low' | 'no_match';

export type MatchResult = {
  tier: MatchTier;
  score: number;
  evidence: {
    barcode_match: boolean;
    snoonu_sku_match: boolean;
    brand_match: boolean;
    name_similarity: number;
    size_match: boolean;
    variant_match: boolean;
    price_within_15pct: boolean;
    phash_match: boolean;
  };
};

const WEIGHTS = {
  barcode: 100,
  snoonu_sku: 80,
  brand: 15,
  name: 25,
  size: 10,
  variant: 5,
  price: 5,
  phash: 15,
};

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    dist += [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][x]!;
  }
  return dist;
}

export function scorePair(source: MatchableProduct, candidate: MatchableProduct): MatchResult {
  if (source.barcode && candidate.barcode && source.barcode === candidate.barcode) {
    return {
      tier: 'exact',
      score: 100,
      evidence: {
        barcode_match: true,
        snoonu_sku_match: !!source.snoonu_sku && source.snoonu_sku === candidate.snoonu_sku,
        brand_match: !!source.brand_name && source.brand_name === candidate.brand_name,
        name_similarity: similarity(source.product_name_en, candidate.product_name_en),
        size_match: !!source.size && source.size === candidate.size,
        variant_match: !!source.variant && source.variant === candidate.variant,
        price_within_15pct: priceWithin(source.price, candidate.price, 0.15),
        phash_match:
          !!source.image_phash &&
          !!candidate.image_phash &&
          hammingHex(source.image_phash, candidate.image_phash) <= 5,
      },
    };
  }

  if (source.snoonu_sku && candidate.snoonu_sku && source.snoonu_sku === candidate.snoonu_sku) {
    return {
      tier: 'high',
      score: WEIGHTS.snoonu_sku + 15,
      evidence: {
        barcode_match: false,
        snoonu_sku_match: true,
        brand_match: !!source.brand_name && source.brand_name === candidate.brand_name,
        name_similarity: similarity(source.product_name_en, candidate.product_name_en),
        size_match: !!source.size && source.size === candidate.size,
        variant_match: !!source.variant && source.variant === candidate.variant,
        price_within_15pct: priceWithin(source.price, candidate.price, 0.15),
        phash_match: false,
      },
    };
  }

  let score = 0;
  const brand_match = !!source.brand_name && source.brand_name === candidate.brand_name;
  if (brand_match) score += WEIGHTS.brand;

  const normSource = normalizeForMatching(stripMarketingNoise(source.product_name_en));
  const normCand = normalizeForMatching(stripMarketingNoise(candidate.product_name_en));
  const nameSimRaw = similarity(normSource, normCand);
  const nameScore = Math.round(nameSimRaw * WEIGHTS.name);
  score += nameScore;

  const size_match = !!source.size && source.size === candidate.size;
  if (size_match) score += WEIGHTS.size;

  const variant_match =
    !!source.variant && source.variant === candidate.variant && source.variant.length > 0;
  if (variant_match) score += WEIGHTS.variant;

  const price_within_15pct = priceWithin(source.price, candidate.price, 0.15);
  if (price_within_15pct) score += WEIGHTS.price;

  const phash_match =
    !!source.image_phash &&
    !!candidate.image_phash &&
    hammingHex(source.image_phash, candidate.image_phash) <= 5;
  if (phash_match) score += WEIGHTS.phash;

  score = Math.min(100, score);

  const tier: MatchTier =
    score >= 95 ? 'exact' : score >= 85 ? 'high' : score >= 60 ? 'medium' : score >= 30 ? 'low' : 'no_match';

  return {
    tier,
    score,
    evidence: {
      barcode_match: false,
      snoonu_sku_match: false,
      brand_match,
      name_similarity: Number(nameSimRaw.toFixed(3)),
      size_match,
      variant_match,
      price_within_15pct,
      phash_match,
    },
  };
}

export function matchAgainst(
  source: MatchableProduct,
  candidates: MatchableProduct[],
  options: { minScore?: number; topK?: number } = {},
): Array<{ candidate: MatchableProduct; result: MatchResult }> {
  const minScore = options.minScore ?? 30;
  const topK = options.topK ?? 5;

  const filtered = source.brand_name
    ? candidates.filter((c) => !c.brand_name || c.brand_name === source.brand_name)
    : candidates;

  const scored = filtered.map((candidate) => ({
    candidate,
    result: scorePair(source, candidate),
  }));

  return scored
    .filter((s) => s.result.score >= minScore)
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, topK);
}

function priceWithin(a: number | null | undefined, b: number | null | undefined, pct: number): boolean {
  if (a == null || b == null || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= pct;
}

export type PlatformMatchDecision = {
  platform: 'shopify' | 'talabat' | 'rafeeq' | 'old_master';
  status: 'matched_auto' | 'matched_review' | 'missing';
  match_result: MatchResult | null;
  candidate_id: string | null;
};

export function decidePlatformMatch(
  platform: PlatformMatchDecision['platform'],
  best: { candidate: MatchableProduct; result: MatchResult } | null,
  autoThreshold = 85,
  reviewThreshold = 60,
): PlatformMatchDecision {
  if (!best || best.result.score < reviewThreshold) {
    return { platform, status: 'missing', match_result: null, candidate_id: null };
  }

  return {
    platform,
    status: best.result.score >= autoThreshold ? 'matched_auto' : 'matched_review',
    match_result: best.result,
    candidate_id: best.candidate.master_sku ?? best.candidate.snoonu_sku ?? null,
  };
}
