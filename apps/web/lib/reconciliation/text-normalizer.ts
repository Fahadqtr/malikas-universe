/**
 * Text normalizer — Phase 13B.
 *
 * Turns a raw product name/brand into a canonical, comparable form by:
 *   - lowercasing + NFKD-normalizing
 *   - removing diacritics
 *   - stripping punctuation
 *   - collapsing whitespace
 *   - removing marketplace noise words ("official", "original", "best seller", …)
 *   - removing unit fragments after variant extraction has captured them
 *
 * Two outputs:
 *   - normalized_name  : a clean, normalized full name (variants kept)
 *   - name_root        : with variant tokens (color/size/pack/model) stripped,
 *                        used for variant grouping
 *
 * Also exports a deterministic token signature for fast similarity comparisons.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Marketing/noise tokens to strip. Multi-word phrases are matched as a whole,
 * single tokens as standalone words.
 */
const NOISE_PHRASES = [
  'best seller',
  'best-seller',
  'limited edition',
  'limited-edition',
  'new arrival',
  'new-arrival',
  'hot pick',
  'top rated',
  'fast delivery',
  'free shipping',
  'made in korea',
  'made in qatar',
  'made in thailand',
  'as seen on tv',
  'tiktok viral',
  'instagram famous',
  'k beauty',
  'k-beauty',
];

const NOISE_TOKENS = new Set([
  'official', 'original', 'authentic', 'genuine', 'real',
  'new', 'newest', 'latest', 'updated',
  'limited', 'exclusive', 'premium', 'deluxe', 'special',
  'viral', 'trending', 'tiktok', 'instagram', 'famous',
  'edition', 'version', 'collection',
  'imported', 'korea', 'korean', 'thailand', 'thai', 'qatar', 'qatari', 'arabia', 'arabian',
  'free', 'shipping', 'delivery',
  'sale', 'offer', 'promo', 'discount',
  'recommended', 'bestseller', 'topselling',
  'item', 'product', 'goods',
  // Article words
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'by',
  // Common Arabic noise (transliterated forms operators may include)
  'asli', 'jadid',
]);

/** Tokens that look like dimensions/units after extraction — drop residuals. */
const UNIT_RESIDUE = new Set([
  'ml', 'g', 'gr', 'gram', 'grams', 'kg', 'oz', 'fl', 'cm', 'mm', 'l', 'liter', 'litre',
  'pc', 'pcs', 'piece', 'pieces', 'pack', 'packs', 'set', 'sets', 'box', 'boxes',
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Strip diacritics, lowercase, normalize unicode width.
 * Keeps Arabic letters intact (they're outside Latin diacritic range).
 */
function basicNormalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')                // Latin diacritics only
    .replace(/[''`´]/g, '')                          // smart quotes
    .replace(/[""«»]/g, '')                          // fancy quotes
    .replace(/[–—−]/g, '-')                          // dash variants
    .toLowerCase()
    .trim();
}

function stripPunctuation(s: string): string {
  // Keep digits, Latin letters, Arabic block, whitespace, and hyphen (variant marker)
  return s.replace(/[^a-z0-9؀-ۿ\s\-]/g, ' ');
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function removePhrases(s: string, phrases: string[]): string {
  let out = s;
  for (const p of phrases) {
    out = out.replace(new RegExp(`\\b${p.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi'), ' ');
  }
  return out;
}

function dropTokens(s: string, drop: Set<string>): string {
  return s
    .split(/\s+/)
    .filter((tok) => tok && !drop.has(tok))
    .join(' ');
}

// ─── Public API ─────────────────────────────────────────────────────────────

export type NormalizedNameResult = {
  normalized_name: string;       // full clean form, variants preserved
  name_root: string;             // with variant tokens stripped
  token_signature: string;       // sorted, deduped tokens — for Jaccard
};

/**
 * Full normalization for a product name. Pass an array of `variant_tokens`
 * to also strip out the values your variant extractor already captured
 * (e.g. ['red', '50ml', '3pcs']).
 */
export function normalizeProductName(
  raw: string | null | undefined,
  variant_tokens: string[] = [],
): NormalizedNameResult {
  if (!raw) return { normalized_name: '', name_root: '', token_signature: '' };

  // Step 1: basic
  let s = basicNormalize(raw);

  // Step 2: kill noise phrases (multi-word) BEFORE we tokenize
  s = removePhrases(s, NOISE_PHRASES);

  // Step 3: strip punctuation
  s = stripPunctuation(s);

  // Step 4: collapse
  s = collapseWhitespace(s);

  // Step 5: drop single-token noise + unit residues
  s = dropTokens(s, NOISE_TOKENS);
  s = dropTokens(s, UNIT_RESIDUE);

  // Step 6: drop pure-number residues left behind by variant extraction
  //   e.g. "medicube zero pore pad 70" → keep "70" only if not in variants
  s = collapseWhitespace(s);

  const normalized_name = s;

  // ─── Build name_root by removing variant tokens ───────────────────────────
  let root = normalized_name;
  if (variant_tokens.length > 0) {
    const normVariants = variant_tokens
      .map((v) => basicNormalize(v))
      .filter((v) => v.length > 0);
    for (const v of normVariants) {
      // Remove as standalone word
      root = root.replace(new RegExp(`\\b${v.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'g'), ' ');
    }
    root = collapseWhitespace(root);
  }

  // ─── Token signature ──────────────────────────────────────────────────────
  const tokens = Array.from(new Set(normalized_name.split(/\s+/).filter(Boolean)));
  tokens.sort();
  const token_signature = tokens.join(' ');

  return { normalized_name, name_root: root, token_signature };
}

/**
 * Normalize a brand string. Brands are simpler: just lowercase + strip non-alnum.
 *   "L'Oréal Paris"  →  "lorealparis"
 *   "Beauty of Joseon"  →  "beautyofjoseon"
 */
export function normalizeBrand(raw: string | null | undefined): string {
  if (!raw) return '';
  return basicNormalize(raw).replace(/[^a-z0-9]/g, '');
}

/**
 * Build a SKU comparison key. SKUs from different platforms often differ in
 * dashes / case — strip them.
 *   "MK-SKIN-0001"  →  "MKSKIN0001"
 *   "mcb_zero_001"  →  "MCBZERO001"
 */
export function normalizeSku(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Drop a list of substrings from a name. Useful when you want to feed
 * variant_extractor output back into a "stripped" name without recomputing.
 */
export function stripSubstrings(name: string, drops: string[]): string {
  let out = name;
  for (const d of drops) {
    if (!d) continue;
    const escaped = basicNormalize(d).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
  }
  return collapseWhitespace(out);
}
