/**
 * Variant detector — Phase 13.5.
 *
 * Inputs:
 *   - An ExtractedProduct from lib/snoonu/extractor
 *   - The product's parent SKU (already generated)
 *
 * Outputs:
 *   - Array of DetectedVariant objects ready to insert into product_variants
 *   - Each variant has: variant_type, variant_value, variant_code, variant_sku,
 *     source_url, source_image_url, price, sort_order
 *
 * Detection passes (in order, first non-empty wins):
 *   1. Structured variants from extractor.variants[]  (highest confidence)
 *   2. Sibling product URLs scraped from the same listing page
 *   3. Product name parsing — "Red", "01 Cinnamon", "50ml", "Set of 3", etc.
 *   4. Description parsing — "Available in: Red, Pink, Coral"
 *
 * Variant types:
 *   - color    →  color name (Red, Hot Pink, Cinnamon)
 *   - shade    →  numeric shade code (01, 02, 03A)
 *   - size     →  ml/g/oz/cm (50ml, 100g, 30 cm)
 *   - quantity →  count (2pcs, 3pcs)
 *   - bundle   →  set size (Set of 3, Combo Pack)
 *   - scent    →  fragrance name (Rose, Vanilla)
 *   - model    →  model identifier (V2, Pro, Mini)
 *   - type     →  variant labelled "Type: ..."
 *   - other    →  catch-all
 *
 * No DB writes. No image pulls. Pure detection.
 */

import type { ExtractedProduct, ExtractedVariant } from '@/lib/snoonu/extractor';
import { generateVariantSku, variantCodeForType } from '@/lib/sku-generator';

export type VariantType =
  | 'color'
  | 'shade'
  | 'size'
  | 'quantity'
  | 'bundle'
  | 'scent'
  | 'model'
  | 'type'
  | 'other';

export type DetectedVariant = {
  variant_type: VariantType;
  variant_name: string;          // Human-readable name (e.g. "Color")
  variant_value: string;         // Raw value ("Red", "50ml", "Set of 3")
  variant_code: string;          // Normalized SKU suffix ("RED", "50ML", "SET3")
  variant_sku: string;           // Full SKU (e.g. "MK-MAKEUP-0001-RED")
  source_url: string | null;     // Sibling Snoonu URL if known
  source_image_url: string | null;
  price: number | null;
  discount_price: number | null;
  sort_order: number;
  confidence: number;            // 0..1
  reason: string;                // How we detected it
  is_default: boolean;           // True for the first/primary variant
};

// ─── Color vocabulary (English + common Arabic) ─────────────────────────────

const COLOR_WORDS = new Set([
  // English
  'red', 'pink', 'rose', 'coral', 'peach', 'nude', 'beige', 'brown', 'tan',
  'black', 'white', 'cream', 'ivory', 'gold', 'silver', 'bronze', 'copper',
  'orange', 'apricot', 'mauve', 'plum', 'purple', 'violet', 'lavender',
  'blue', 'navy', 'teal', 'turquoise', 'green', 'olive', 'yellow', 'mustard',
  'grey', 'gray', 'charcoal',
  'hot pink', 'baby pink', 'dusty rose', 'wine', 'burgundy', 'cherry', 'berry',
  'fuchsia', 'magenta', 'salmon', 'terracotta', 'caramel', 'chocolate',
  'cinnamon', 'mocha', 'espresso', 'champagne', 'pearl', 'opal',
  // Arabic transliterations sometimes used
  'ahmar', 'wardi', 'aswad', 'abyad',
]);

const SCENT_HINTS = [
  'rose', 'jasmine', 'vanilla', 'sandalwood', 'oud', 'musk', 'amber',
  'lavender', 'lemon', 'lime', 'mint', 'coconut', 'cherry blossom',
  'peach', 'apple', 'berry', 'green tea', 'cucumber', 'aloe',
];

// ─── Regex patterns ─────────────────────────────────────────────────────────

// "50ml", "100 ml", "30g", "2.5 oz", "30cm"
const SIZE_RE = /\b(\d+(?:[.,]\d+)?)\s?(ml|g|gr|gram|grams|kg|oz|fl\s?oz|cm|mm|l|liter|litre)\b/i;
// "01", "02 Coral", "shade 03A", "#04"
const SHADE_RE = /\b(?:shade|color|colour|no\.?)\s*(\d{1,3}[a-z]?)\b/i;
// Standalone numeric shade: "01 Strawberry" at start of a string
const STANDALONE_SHADE_RE = /^(\d{1,3}[a-z]?)\s*[-:•·]?\s*(\w[\w\s]*)$/i;
// "2pcs", "3 pcs", "set of 3", "combo pack of 2", "pack of 4"
const QUANTITY_RE = /\b(?:set\s+of\s+|pack\s+of\s+|combo\s+of\s+)?(\d{1,2})\s?(pc|pcs|pieces?|piece|set|sets|pk|pack)?\b/i;
// "Available in: ", "Comes in: ", "Choose color: "
const LIST_INTRO_RE = /(?:available\s+in|comes\s+in|choose\s+(?:color|colour|shade|size)|select\s+(?:color|colour|shade|size))\s*[:\-]\s*/i;

// ─── Helpers ────────────────────────────────────────────────────────────────

function classifyValue(raw: string): VariantType {
  const v = raw.trim().toLowerCase();
  if (!v) return 'other';

  if (SIZE_RE.test(v)) return 'size';
  if (SHADE_RE.test(v)) return 'shade';
  if (STANDALONE_SHADE_RE.test(v) && /^\d/.test(v)) return 'shade';
  if (/\bset\s+of\b|\bcombo\b|\bbundle\b|\bpack\s+of\b|\bkit\b/i.test(v)) return 'bundle';
  if (QUANTITY_RE.test(v) && /pc|pcs|piece/.test(v)) return 'quantity';

  // Check color match
  for (const c of COLOR_WORDS) {
    if (v === c || v.startsWith(c + ' ') || v.endsWith(' ' + c) || v.includes(' ' + c + ' ')) {
      return 'color';
    }
  }
  // Scent match
  for (const s of SCENT_HINTS) {
    if (v.includes(s)) return 'scent';
  }
  // Model heuristic: "V2", "Pro", "Mini", "Plus"
  if (/\b(v\d+|pro|mini|plus|max|lite|elite)\b/i.test(v)) return 'model';

  return 'other';
}

function variantNameForType(type: VariantType): string {
  switch (type) {
    case 'color': return 'Color';
    case 'shade': return 'Shade';
    case 'size': return 'Size';
    case 'quantity': return 'Quantity';
    case 'bundle': return 'Bundle';
    case 'scent': return 'Scent';
    case 'model': return 'Model';
    case 'type': return 'Type';
    default: return 'Variant';
  }
}

/** Strip surrounding quotes/dashes/whitespace, collapse spaces. */
function cleanValue(s: string): string {
  return s
    .replace(/^["'\s\-•·:]+|["'\s\-•·:]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Pass 1: structured variants from extractor ─────────────────────────────

function fromExtractedVariants(
  ev: ExtractedVariant[],
  parentSku: string,
): DetectedVariant[] {
  return ev
    .map((v, idx) => {
      const value = cleanValue(v.variant_value || v.variant_name);
      if (!value) return null;
      const type: VariantType = v.variant_type ?? classifyValue(value);
      const code = variantCodeForType(type, value);
      if (!code) return null;
      const variantSku = generateVariantSku(parentSku, value, code);
      return {
        variant_type: type,
        variant_name: variantNameForType(type),
        variant_value: value,
        variant_code: code,
        variant_sku: variantSku,
        source_url: v.source_url ?? null,
        source_image_url: v.source_image_url ?? null,
        price: v.price ?? null,
        discount_price: v.discount_price ?? null,
        sort_order: idx,
        confidence: 0.95,
        reason: 'extractor_structured',
        is_default: idx === 0,
      } as DetectedVariant;
    })
    .filter((v): v is DetectedVariant => v !== null);
}

// ─── Pass 2: parse name + description for inline variants ───────────────────

function parseFromText(text: string): Array<{ value: string; type: VariantType; reason: string }> {
  const out: Array<{ value: string; type: VariantType; reason: string }> = [];

  // "Available in: Red, Pink, Coral"
  const listMatch = text.match(new RegExp(LIST_INTRO_RE.source + '([^.\\n]+)', 'i'));
  if (listMatch) {
    const list = listMatch[1]!.split(/\s*[,،/]\s*|\s+and\s+/i);
    for (const item of list) {
      const v = cleanValue(item);
      if (v && v.length <= 30) {
        out.push({ value: v, type: classifyValue(v), reason: 'list_in_text' });
      }
    }
  }

  // Size in name: "Cleanser 200ml"
  const sizeMatch = text.match(SIZE_RE);
  if (sizeMatch) {
    out.push({
      value: `${sizeMatch[1]!}${sizeMatch[2]!.toLowerCase().replace(/\s+/g, '')}`,
      type: 'size',
      reason: 'size_in_text',
    });
  }

  // Shade prefix: "01 Cinnamon Roll"
  const shadeStartMatch = text.match(/^(\d{1,3}[a-z]?)\s+([A-Z][\w\s]+)$/);
  if (shadeStartMatch) {
    out.push({
      value: `${shadeStartMatch[1]} ${shadeStartMatch[2]}`.trim(),
      type: 'shade',
      reason: 'shade_prefix_in_name',
    });
  }

  return out;
}

function fromTextFields(
  product: ExtractedProduct,
  parentSku: string,
  startSortOrder: number,
): DetectedVariant[] {
  const blob = [product.name_en, product.name_ar, product.description_en, product.description_ar]
    .filter(Boolean)
    .join('\n');

  if (!blob) return [];

  const parsed = parseFromText(blob);
  const seen = new Set<string>();
  const out: DetectedVariant[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]!;
    const code = variantCodeForType(p.type, p.value);
    if (!code) continue;
    const key = `${p.type}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      variant_type: p.type,
      variant_name: variantNameForType(p.type),
      variant_value: p.value,
      variant_code: code,
      variant_sku: generateVariantSku(parentSku, p.value, code),
      source_url: null,
      source_image_url: null,
      price: null,
      discount_price: null,
      sort_order: startSortOrder + i,
      confidence: 0.65,
      reason: p.reason,
      is_default: false,
    });
  }
  return out;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Detect variants for an extracted product.
 *
 * Strategy:
 *   - If extractor returned structured variants → use those (high confidence).
 *   - Otherwise scan name+description for inline variant patterns (lower confidence).
 *   - Deduplicate by (variant_type, variant_code).
 *   - First variant becomes default.
 */
export function detectVariants(
  product: ExtractedProduct,
  parentSku: string,
): DetectedVariant[] {
  const structured = fromExtractedVariants(product.variants ?? [], parentSku);
  if (structured.length > 0) {
    // Trust the structured set; don't pollute with text-pass guesses.
    return dedupe(structured);
  }

  const text = fromTextFields(product, parentSku, 0);
  if (text.length === 0) return [];

  // Mark first as default
  text[0]!.is_default = true;
  return dedupe(text);
}

function dedupe(variants: DetectedVariant[]): DetectedVariant[] {
  const seen = new Set<string>();
  const out: DetectedVariant[] = [];
  for (const v of variants) {
    const key = `${v.variant_type}:${v.variant_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  // Re-number sort_order after dedupe
  out.forEach((v, i) => { v.sort_order = i; });
  return out;
}

// ─── Useful exports for the review UI ──────────────────────────────────────

/** Summarize a variant set for display: "3 colors • 2 sizes" */
export function summarizeVariants(variants: DetectedVariant[]): string {
  if (variants.length === 0) return 'no variants';
  const byType = new Map<VariantType, number>();
  for (const v of variants) byType.set(v.variant_type, (byType.get(v.variant_type) ?? 0) + 1);
  const parts: string[] = [];
  for (const [type, n] of byType) {
    parts.push(`${n} ${type}${n > 1 ? 's' : ''}`);
  }
  return parts.join(' • ');
}

/** Group variants by type. Useful when rendering the review table. */
export function groupVariantsByType(
  variants: DetectedVariant[],
): Record<VariantType, DetectedVariant[]> {
  const out = {} as Record<VariantType, DetectedVariant[]>;
  for (const v of variants) {
    if (!out[v.variant_type]) out[v.variant_type] = [];
    out[v.variant_type].push(v);
  }
  return out;
}
