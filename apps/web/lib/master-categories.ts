/**
 * Master Categories — locked list for Malika's Universe.
 *
 * Only these 11 categories exist. Anything that doesn't fit goes to
 * `Trending Products` temporarily and is flagged for review.
 *
 * Used by:
 *   - SKU generator (prefix mapping)
 *   - Snoonu import (category inference)
 *   - Product create/edit forms (dropdown)
 *   - Validation
 */

export const MASTER_CATEGORIES = [
  'Korean Skincare',
  'Makeup',
  'Hair Care',
  'Body Care',
  'Perfumes',
  'Beauty Tools',
  'Bags & Accessories',
  'Gifts & Sets',
  'Kids & Toys',
  'Thai Products',
  'Trending Products',
] as const;

export type MasterCategory = (typeof MASTER_CATEGORIES)[number];

export function isMasterCategory(value: string): value is MasterCategory {
  return (MASTER_CATEGORIES as readonly string[]).includes(value);
}

// ─── Category inference rules ──────────────────────────────────────────────
// Apply in order. First match wins. Korean Skincare beats Makeup if both apply.

const KOREAN_BRANDS = new Set([
  'medicube', 'anua', 'cosrx', 'beauty of joseon', 'skin1004', 'round lab',
  'axis-y', 'axis y', 'haruharu', 'numbuzin', 'torriden', 'some by mi',
  'isntree', 'pyunkang yul', 'pyunkang-yul', "missha", "innisfree", "etude",
  "laneige", "klairs", "purito", "by wishtrend", "iunik", "neogen",
]);

const HAIR_BRANDS = new Set(['k18', 'olaplex', 'kerastase', 'davines', 'moroccanoil']);

const MAKEUP_TYPES = [
  'lip gloss', 'lipstick', 'lip tint', 'lip balm', 'lip oil',
  'blush', 'cheek tint', 'highlighter', 'bronzer',
  'concealer', 'foundation', 'bb cream', 'cc cream', 'cushion',
  'eyeshadow', 'eyeshadow palette', 'mascara', 'eyeliner', 'brow',
  'primer', 'setting spray', 'powder', 'contour', 'glitter',
];

const HAIR_TYPES = [
  'shampoo', 'conditioner', 'hair oil', 'hair mask', 'scalp serum',
  'heat protectant', 'hair spray', 'dry shampoo', 'leave-in',
];

const BODY_TYPES = [
  'body lotion', 'body mist', 'body oil', 'body scrub', 'deodorant',
  'hand cream', 'foot cream', 'body wash', 'body butter', 'sunscreen body',
];

const PERFUME_TYPES = [
  'perfume', 'fragrance', 'eau de parfum', 'eau de toilette', 'edp', 'edt',
];

const TOOLS_TYPES = [
  'derma pen', 'gua sha', 'jade roller', 'makeup brush', 'mirror',
  'beauty sponge', 'eyelash curler', 'tweezers', 'face roller', 'spatula',
];

const BAGS_TYPES = [
  'bag', 'pouch', 'phone case', 'keychain', 'wallet', 'cardholder', 'tote',
];

const KIDS_TYPES = [
  'labubu', 'toy', 'doll', 'plushie', 'sticker', 'kids item', 'kids set',
];

const GIFTS_TYPES = [
  'gift set', 'combo', 'bundle', 'kit', 'hamper', 'pack of',
];

const TRENDING_TAGS = ['viral', 'tiktok', 'trending', 'new arrival'];

/**
 * Best-effort inference of master category from extracted Snoonu data.
 *
 * Strategy (apply in order, first match wins):
 *   1. Brand-based override (Korean / Hair brands)
 *   2. Product type / name keywords
 *   3. Tag-based fallback (trending/viral)
 *   4. Default: Trending Products
 */
export function inferMasterCategory(input: {
  brand?: string | null;
  product_type?: string | null;
  product_name?: string | null;
  category_hint?: string | null;
  tags?: string[];
}): { category: MasterCategory; confidence: number; reason: string } {
  const brand = (input.brand ?? '').toLowerCase().trim();
  const type = (input.product_type ?? '').toLowerCase().trim();
  const name = (input.product_name ?? '').toLowerCase().trim();
  const hint = (input.category_hint ?? '').toLowerCase().trim();
  const tags = (input.tags ?? []).map((t) => t.toLowerCase());

  // 1. Direct hint match
  if (hint) {
    const direct = MASTER_CATEGORIES.find((c) => c.toLowerCase() === hint);
    if (direct) return { category: direct, confidence: 1.0, reason: 'hint_exact' };
  }

  // 2. Korean brand → Korean Skincare
  if (brand && KOREAN_BRANDS.has(brand)) {
    return { category: 'Korean Skincare', confidence: 0.95, reason: `brand:${brand}` };
  }

  // 3. Hair brand → Hair Care
  if (brand && HAIR_BRANDS.has(brand)) {
    return { category: 'Hair Care', confidence: 0.95, reason: `brand:${brand}` };
  }

  // Search blob: type + name + hint
  const blob = `${type} ${name} ${hint}`;

  function containsAny(list: string[]): string | null {
    for (const term of list) {
      if (blob.includes(term)) return term;
    }
    return null;
  }

  // 4. Type-based matches (in priority order)
  const skinTerms = ['cleanser', 'toner', 'serum', 'essence', 'ampoule', 'moisturizer', 'sunscreen', 'sheet mask', 'sleeping mask', 'eye cream', 'exfoliator', 'k-beauty', 'kbeauty', 'korean'];
  const skinMatch = containsAny(skinTerms);
  if (skinMatch) return { category: 'Korean Skincare', confidence: 0.85, reason: `term:${skinMatch}` };

  const makeupMatch = containsAny(MAKEUP_TYPES);
  if (makeupMatch) return { category: 'Makeup', confidence: 0.85, reason: `term:${makeupMatch}` };

  const hairMatch = containsAny(HAIR_TYPES);
  if (hairMatch) return { category: 'Hair Care', confidence: 0.85, reason: `term:${hairMatch}` };

  const bodyMatch = containsAny(BODY_TYPES);
  if (bodyMatch) return { category: 'Body Care', confidence: 0.85, reason: `term:${bodyMatch}` };

  const perfumeMatch = containsAny(PERFUME_TYPES);
  if (perfumeMatch) return { category: 'Perfumes', confidence: 0.85, reason: `term:${perfumeMatch}` };

  const toolsMatch = containsAny(TOOLS_TYPES);
  if (toolsMatch) return { category: 'Beauty Tools', confidence: 0.85, reason: `term:${toolsMatch}` };

  const bagsMatch = containsAny(BAGS_TYPES);
  if (bagsMatch) return { category: 'Bags & Accessories', confidence: 0.85, reason: `term:${bagsMatch}` };

  const kidsMatch = containsAny(KIDS_TYPES);
  if (kidsMatch) return { category: 'Kids & Toys', confidence: 0.85, reason: `term:${kidsMatch}` };

  const giftsMatch = containsAny(GIFTS_TYPES);
  if (giftsMatch) return { category: 'Gifts & Sets', confidence: 0.85, reason: `term:${giftsMatch}` };

  // 5. Trending tag fallback
  if (tags.some((t) => TRENDING_TAGS.includes(t))) {
    return { category: 'Trending Products', confidence: 0.6, reason: 'tag:trending' };
  }

  // 6. Default
  return { category: 'Trending Products', confidence: 0.2, reason: 'fallback' };
}
