/**
 * Fuzzy match scorer — Phase 13B.
 *
 * Compares two normalized strings using a blend of:
 *   - Jaccard token overlap (good for word-order changes)
 *   - Levenshtein ratio    (good for typos / minor edits)
 *
 * Returns:
 *   { score, tier, differing_tokens }
 *
 * Tiers:
 *   exact       1.00          — strings identical after normalization
 *   strong      ≥ 0.92        — clearly the same product
 *   possible    0.75–0.92     — same product, needs human eyes
 *   low         < 0.75        — different products
 *
 * Inputs are expected to be ALREADY normalized (lowercase, punctuation stripped,
 * noise words removed). Pass output of `normalizeProductName().normalized_name`.
 */

export type MatchTier = 'exact' | 'strong' | 'possible' | 'low';

export type FuzzyResult = {
  score: number;             // 0..1 (blended)
  jaccard: number;
  levenshtein_ratio: number;
  tier: MatchTier;
  differing_tokens: string[];
  shared_tokens: string[];
};

// ─── Tunables ───────────────────────────────────────────────────────────────

const TIER_THRESHOLD_STRONG = 0.92;
const TIER_THRESHOLD_POSSIBLE = 0.75;
const JACCARD_WEIGHT = 0.65;
const LEVEN_WEIGHT = 0.35;

// ─── Internals ──────────────────────────────────────────────────────────────

function tokenize(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function jaccardScore(a: string[], b: string[]): { score: number; shared: string[]; diff: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  const shared: string[] = [];
  const diff: string[] = [];
  for (const t of sa) {
    if (sb.has(t)) shared.push(t);
    else diff.push(t);
  }
  for (const t of sb) {
    if (!sa.has(t)) diff.push(t);
  }
  const union = sa.size + sb.size - shared.length;
  const score = union === 0 ? 0 : shared.length / union;
  return { score, shared, diff: Array.from(new Set(diff)) };
}

/** Levenshtein with early-exit cap. */
function levenshtein(a: string, b: string, max = 64): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function levRatio(a: string, b: string): number {
  if (!a && !b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const d = levenshtein(a, b, maxLen);
  return 1 - d / maxLen;
}

function tierFor(score: number): MatchTier {
  if (score >= 0.999) return 'exact';
  if (score >= TIER_THRESHOLD_STRONG) return 'strong';
  if (score >= TIER_THRESHOLD_POSSIBLE) return 'possible';
  return 'low';
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function fuzzyCompare(a: string, b: string): FuzzyResult {
  if (!a || !b) {
    return {
      score: 0,
      jaccard: 0,
      levenshtein_ratio: 0,
      tier: 'low',
      differing_tokens: [],
      shared_tokens: [],
    };
  }

  if (a === b) {
    return {
      score: 1,
      jaccard: 1,
      levenshtein_ratio: 1,
      tier: 'exact',
      differing_tokens: [],
      shared_tokens: tokenize(a),
    };
  }

  const ta = tokenize(a);
  const tb = tokenize(b);
  const jac = jaccardScore(ta, tb);
  const lev = levRatio(a, b);
  const blended = JACCARD_WEIGHT * jac.score + LEVEN_WEIGHT * lev;

  return {
    score: blended,
    jaccard: jac.score,
    levenshtein_ratio: lev,
    tier: tierFor(blended),
    differing_tokens: jac.diff,
    shared_tokens: jac.shared,
  };
}

/**
 * Best-match search: given a needle, find the highest-scoring item in a
 * haystack. Returns the top N candidates.
 *
 * Cheap version: O(N*L) string comparisons. For 13B's scale (≤10k rows × 10k
 * rows) this runs in seconds; if it ever needs to be faster, swap in a
 * blocking key (e.g. first letter or brand prefix) before scoring.
 */
export function bestMatches<T>(
  needle: string,
  haystack: Array<{ id: T; normalized_name: string; normalized_brand?: string | null }>,
  opts: {
    brand_hint?: string | null;       // boost candidates that share this brand
    top_k?: number;                   // default 3
    min_score?: number;               // ignore anything below this (default 0.5)
  } = {},
): Array<{ id: T; score: number; tier: MatchTier; differing_tokens: string[] }> {
  const topK = opts.top_k ?? 3;
  const minScore = opts.min_score ?? 0.5;
  const scored: Array<{ id: T; score: number; tier: MatchTier; differing_tokens: string[] }> = [];

  for (const item of haystack) {
    if (!item.normalized_name) continue;
    const cmp = fuzzyCompare(needle, item.normalized_name);
    let score = cmp.score;

    // Small boost if brand matches
    if (opts.brand_hint && item.normalized_brand) {
      if (opts.brand_hint === item.normalized_brand) score = Math.min(1, score + 0.05);
    }

    if (score < minScore) continue;
    scored.push({ id: item.id, score, tier: tierFor(score), differing_tokens: cmp.differing_tokens });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Boolean shortcut for "is this clearly the same product?" — used by
 * the comparator's exact-pair pass before falling through to fuzzy.
 */
export function isStrongMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return fuzzyCompare(a, b).tier === 'strong' || fuzzyCompare(a, b).tier === 'exact';
}
