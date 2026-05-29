/**
 * Category extractor — Phase 13B.15.
 *
 * Determines the canonical category for any imported platform product using
 * a four-pass strategy. First non-null result wins.
 *
 *   PASS 1 — Direct column:
 *     If the normalizer already mapped a `category` or `product_type` column
 *     and the value cleans to a recognized canonical category, use it.
 *     Confidence: 1.00. Source: 'direct_column'.
 *
 *   PASS 2 — Brand → canonical category map:
 *     Many beauty brands ONLY make one category of product. If the row's
 *     brand is in our brand map, infer the category from that.
 *     Confidence: 0.95. Source: 'inferred_rule'.
 *
 *   PASS 3 — Keyword match against name + product_type + subcategory:
 *     Scan a joined blob for skincare / makeup / hair / perfume / etc.
 *     keywords. Priority order determines ties.
 *     Confidence: 0.85. Source: 'inferred_rule'.
 *
 *   PASS 4 — Description-language brand-agnostic keyword sweep:
 *     Lower-confidence pass over the description/keywords field.
 *     Confidence: 0.70. Source: 'inferred_rule'.
 *
 *   If still nothing → category_missing=true. UI flags these for manual review.
 *
 * The extractor produces canonical names from a fixed set (see CANONICAL_CATEGORIES)
 * so reconciliation across platforms compares apples to apples.
 */

// ─── Canonical categories (output vocabulary) ───────────────────────────────

export const CANONICAL_CATEGORIES = [
  'Korean Skincare',
  'Makeup',
  'Hair Care',
  'Body Care',
  'Perfumes',
  'Beauty Tools',
  'Bags & Accessories',
  'Nail Care',
  'Gifts & Sets',
  'Kids & Toys',
  'Thai Products',
  'Trending Products',
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

// ─── Inputs / outputs ───────────────────────────────────────────────────────

export type CategoryInput = {
  platform: string;                  // 'snoonu' | 'talabat' | 'rafeeq' | 'shopify' | 'internal' | 'other'
  raw_category?: string | null;      // value from the normalizer's category column
  raw_subcategory?: string | null;
  product_name?: string | null;
  product_type?: string | null;
  brand?: string | null;
  description?: string | null;
  keywords?: string | null;          // pipe/comma separated tags if available
};

export type CategoryResult = {
  raw_category: string | null;
  raw_subcategory: string | null;
  category_name: string | null;
  subcategory_name: string | null;
  category_confidence: number | null;
  category_source: 'direct_column' | 'inferred_rule' | 'inferred_ai' | 'manual' | null;
  category_missing: boolean;
  /** Why we chose this category — debug field. */
  reason: string;
};

// ─── Direct-column aliases (when a string looks like a canonical category) ──
// Lowercased lookup; first match wins.
const DIRECT_LOOKUP: Record<string, CanonicalCategory> = {
  // Korean Skincare
  'korean skincare': 'Korean Skincare',
  'skincare': 'Korean Skincare',
  'skin care': 'Korean Skincare',
  'k-beauty': 'Korean Skincare',
  'k beauty': 'Korean Skincare',
  'face care': 'Korean Skincare',
  'facial care': 'Korean Skincare',

  // Makeup
  'makeup': 'Makeup',
  'make up': 'Makeup',
  'make-up': 'Makeup',
  'cosmetics': 'Makeup',
  'color cosmetics': 'Makeup',
  'face makeup': 'Makeup',

  // Hair Care
  'hair care': 'Hair Care',
  'haircare': 'Hair Care',
  'hair': 'Hair Care',
  'scalp care': 'Hair Care',

  // Body Care
  'body care': 'Body Care',
  'bodycare': 'Body Care',
  'body': 'Body Care',
  'hand & body': 'Body Care',
  'bath & body': 'Body Care',

  // Perfumes
  'perfumes': 'Perfumes',
  'perfume': 'Perfumes',
  'fragrance': 'Perfumes',
  'fragrances': 'Perfumes',
  'cologne': 'Perfumes',
  'eau de parfum': 'Perfumes',
  'eau de toilette': 'Perfumes',

  // Beauty Tools
  'beauty tools': 'Beauty Tools',
  'tools': 'Beauty Tools',
  'beauty devices': 'Beauty Tools',
  'devices': 'Beauty Tools',
  'accessories tools': 'Beauty Tools',

  // Bags & Accessories
  'bags & accessories': 'Bags & Accessories',
  'bags and accessories': 'Bags & Accessories',
  'accessories': 'Bags & Accessories',
  'bags': 'Bags & Accessories',

  // Nail Care
  'nail care': 'Nail Care',
  'nails': 'Nail Care',
  'nail': 'Nail Care',
  'manicure': 'Nail Care',

  // Gifts & Sets
  'gifts & sets': 'Gifts & Sets',
  'gifts and sets': 'Gifts & Sets',
  'gift sets': 'Gifts & Sets',
  'gift set': 'Gifts & Sets',
  'sets': 'Gifts & Sets',
  'bundles': 'Gifts & Sets',
  'combos': 'Gifts & Sets',

  // Kids & Toys
  'kids & toys': 'Kids & Toys',
  'kids and toys': 'Kids & Toys',
  'kids': 'Kids & Toys',
  'toys': 'Kids & Toys',

  // Thai
  'thai products': 'Thai Products',
  'thai': 'Thai Products',

  // Trending
  'trending products': 'Trending Products',
  'trending': 'Trending Products',
  'new arrivals': 'Trending Products',
  'viral': 'Trending Products',
};

// ─── Brand → category map ───────────────────────────────────────────────────
const BRAND_CATEGORY: Record<string, CanonicalCategory> = {
  // Korean Skincare
  medicube: 'Korean Skincare',
  anua: 'Korean Skincare',
  cosrx: 'Korean Skincare',
  'beauty of joseon': 'Korean Skincare',
  skin1004: 'Korean Skincare',
  'round lab': 'Korean Skincare',
  'axis-y': 'Korean Skincare',
  'axis y': 'Korean Skincare',
  haruharu: 'Korean Skincare',
  numbuzin: 'Korean Skincare',
  torriden: 'Korean Skincare',
  'some by mi': 'Korean Skincare',
  isntree: 'Korean Skincare',
  'pyunkang yul': 'Korean Skincare',
  'pyunkang-yul': 'Korean Skincare',
  missha: 'Korean Skincare',
  innisfree: 'Korean Skincare',
  etude: 'Korean Skincare',
  laneige: 'Korean Skincare',
  klairs: 'Korean Skincare',
  purito: 'Korean Skincare',
  'by wishtrend': 'Korean Skincare',
  iunik: 'Korean Skincare',
  neogen: 'Korean Skincare',

  // Hair
  k18: 'Hair Care',
  olaplex: 'Hair Care',
  kerastase: 'Hair Care',
  davines: 'Hair Care',
  moroccanoil: 'Hair Care',
};

// ─── Keyword rules ──────────────────────────────────────────────────────────
// Multi-word phrases must come before single-word ones in each list, since
// match order is first-hit. Single-token words use word-boundary regex.

type Rule = {
  category: CanonicalCategory;
  // Phrases (matched as substrings, case-insensitive)
  phrases?: string[];
  // Tokens (matched as standalone words)
  tokens?: string[];
};

const RULES: Rule[] = [
  // Order matters: more specific categories come first so e.g. "lip" doesn't
  // get pulled by a generic "skincare" rule.
  {
    category: 'Korean Skincare',
    phrases: [
      'sheet mask', 'sleeping mask', 'sleeping pack', 'eye cream', 'eye patch',
      'eye serum', 'face wash', 'face cream', 'face serum', 'face mask',
      'micellar water', 'cleansing oil', 'cleansing balm', 'cleansing foam',
      'pore pad', 'acne patch', 'snail mucin', 'centella', 'azelaic',
      'hyaluronic', 'niacinamide', 'vitamin c serum',
    ],
    tokens: [
      'cleanser', 'toner', 'serum', 'essence', 'ampoule', 'moisturizer',
      'sunscreen', 'spf', 'exfoliator', 'peeling', 'mask', 'pad', 'patches',
      'patch', 'cream',
    ],
  },
  {
    category: 'Nail Care',
    phrases: ['press on nail', 'press on nails', 'gel polish', 'nail polish', 'nail file', 'nail care', 'top coat', 'base coat'],
    tokens: ['nail', 'nails', 'manicure', 'pedicure', 'cuticle'],
  },
  {
    category: 'Makeup',
    phrases: [
      'lip tint', 'lip gloss', 'lip oil', 'lip balm', 'lip mask',
      'cheek tint', 'cushion foundation', 'bb cream', 'cc cream',
      'eye shadow', 'eyeshadow palette', 'setting spray', 'liquid lipstick',
    ],
    tokens: [
      'lipstick', 'gloss', 'tint', 'blush', 'highlighter', 'bronzer',
      'concealer', 'foundation', 'cushion', 'eyeshadow', 'mascara', 'eyeliner',
      'brow', 'eyebrow', 'primer', 'powder', 'contour', 'glitter',
    ],
  },
  {
    category: 'Hair Care',
    phrases: ['hair oil', 'hair mask', 'scalp serum', 'heat protectant', 'hair spray', 'dry shampoo', 'leave-in', 'leave in', 'hair treatment'],
    tokens: ['shampoo', 'conditioner', 'hair', 'scalp'],
  },
  {
    category: 'Perfumes',
    phrases: ['eau de parfum', 'eau de toilette', 'body mist', 'fragrance mist'],
    tokens: ['perfume', 'fragrance', 'cologne', 'edp', 'edt'],
  },
  {
    category: 'Beauty Tools',
    phrases: ['derma pen', 'gua sha', 'jade roller', 'face roller', 'makeup brush', 'beauty sponge', 'eyelash curler', 'led mask', 'led face'],
    tokens: ['mirror', 'tweezers', 'spatula', 'device', 'massager'],
  },
  {
    category: 'Body Care',
    phrases: ['body lotion', 'body mist', 'body oil', 'body scrub', 'hand cream', 'foot cream', 'body wash', 'body butter'],
    tokens: ['deodorant'],
  },
  {
    category: 'Bags & Accessories',
    phrases: ['phone case', 'phone strap', 'cardholder', 'card holder', 'makeup bag', 'cosmetic bag'],
    tokens: ['bag', 'pouch', 'keychain', 'wallet', 'tote', 'scarf'],
  },
  {
    category: 'Gifts & Sets',
    phrases: ['gift set', 'gift bundle', 'combo pack', 'pack of', 'set of', 'value set', 'mini kit'],
    tokens: ['bundle', 'hamper', 'kit', 'set', 'combo'],
  },
  {
    category: 'Kids & Toys',
    phrases: ['labubu', 'plush toy', 'kids set'],
    tokens: ['toy', 'doll', 'plushie', 'sticker'],
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function clean(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tryDirectLookup(value: string): CanonicalCategory | null {
  const key = clean(value);
  if (!key) return null;
  if (DIRECT_LOOKUP[key]) return DIRECT_LOOKUP[key];
  // Try a softer match — strip punctuation
  const stripped = key.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  if (DIRECT_LOOKUP[stripped]) return DIRECT_LOOKUP[stripped];
  // Substring match — if the value CONTAINS a canonical key
  for (const [needle, cat] of Object.entries(DIRECT_LOOKUP)) {
    if (key.includes(needle)) return cat;
  }
  return null;
}

function tryBrandLookup(brand: string | null | undefined): CanonicalCategory | null {
  if (!brand) return null;
  return BRAND_CATEGORY[clean(brand)] ?? null;
}

function tryKeywordRules(blob: string): { category: CanonicalCategory; matched: string } | null {
  const b = clean(blob);
  if (!b) return null;
  for (const rule of RULES) {
    if (rule.phrases) {
      for (const phrase of rule.phrases) {
        if (b.includes(phrase)) return { category: rule.category, matched: phrase };
      }
    }
    if (rule.tokens) {
      for (const tok of rule.tokens) {
        const re = new RegExp(`\\b${tok.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
        if (re.test(b)) return { category: rule.category, matched: tok };
      }
    }
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function extractCategory(input: CategoryInput): CategoryResult {
  const rawCat = input.raw_category?.trim() || null;
  const rawSub = input.raw_subcategory?.trim() || null;

  // PASS 1 — direct column
  if (rawCat) {
    const direct = tryDirectLookup(rawCat);
    if (direct) {
      return {
        raw_category: rawCat,
        raw_subcategory: rawSub,
        category_name: direct,
        subcategory_name: rawSub,
        category_confidence: 1.0,
        category_source: 'direct_column',
        category_missing: false,
        reason: `direct_column:"${rawCat}"`,
      };
    }
    // We have a raw category but couldn't map it canonically — keep raw, run inference for canonical
    const inferred = inferFromContext(input);
    if (inferred) {
      return {
        raw_category: rawCat,
        raw_subcategory: rawSub,
        category_name: inferred.category,
        subcategory_name: rawSub,
        category_confidence: 0.85,
        category_source: 'inferred_rule',
        category_missing: false,
        reason: `direct_raw_but_inferred_canonical:${inferred.reason}`,
      };
    }
    // We have raw but can't map. Store raw_category as-is in category_name so
    // the UI shows something — confidence is low.
    return {
      raw_category: rawCat,
      raw_subcategory: rawSub,
      category_name: rawCat,        // pass-through (uncanonical)
      subcategory_name: rawSub,
      category_confidence: 0.5,
      category_source: 'direct_column',
      category_missing: false,
      reason: `direct_column_unmapped:"${rawCat}"`,
    };
  }

  // PASS 2-4 — inference
  const inferred = inferFromContext(input);
  if (inferred) {
    return {
      raw_category: rawCat,
      raw_subcategory: rawSub,
      category_name: inferred.category,
      subcategory_name: rawSub,
      category_confidence: inferred.confidence,
      category_source: 'inferred_rule',
      category_missing: false,
      reason: inferred.reason,
    };
  }

  // Nothing worked
  return {
    raw_category: rawCat,
    raw_subcategory: rawSub,
    category_name: null,
    subcategory_name: rawSub,
    category_confidence: null,
    category_source: null,
    category_missing: true,
    reason: 'no_signal',
  };
}

function inferFromContext(input: CategoryInput): { category: CanonicalCategory; confidence: number; reason: string } | null {
  // PASS 2 — brand
  const byBrand = tryBrandLookup(input.brand);
  if (byBrand) {
    return { category: byBrand, confidence: 0.95, reason: `brand:${input.brand}` };
  }

  // PASS 3 — keyword match against name + product_type + subcategory
  const primaryBlob = [
    input.product_name,
    input.product_type,
    input.raw_subcategory,
  ]
    .filter(Boolean)
    .join(' ');
  const primaryHit = tryKeywordRules(primaryBlob);
  if (primaryHit) {
    return {
      category: primaryHit.category,
      confidence: 0.85,
      reason: `keyword:${primaryHit.matched}`,
    };
  }

  // PASS 4 — wider sweep over description + keywords field
  const wideBlob = [input.description, input.keywords].filter(Boolean).join(' ');
  if (wideBlob) {
    const wideHit = tryKeywordRules(wideBlob);
    if (wideHit) {
      return {
        category: wideHit.category,
        confidence: 0.7,
        reason: `keyword_wide:${wideHit.matched}`,
      };
    }
  }

  return null;
}

/**
 * Convenience: bulk re-infer for an array of rows. Used by the "Auto-infer
 * missing categories" bulk action in the import preview UI.
 */
export function bulkInfer(rows: CategoryInput[]): CategoryResult[] {
  return rows.map(extractCategory);
}

/**
 * Type guard: is this string one of the canonical categories?
 */
export function isCanonicalCategory(s: string): s is CanonicalCategory {
  return (CANONICAL_CATEGORIES as readonly string[]).includes(s);
}
