/**
 * Variant extractor — Phase 13B.
 *
 * Parses structured variant attributes out of product names so the comparator
 * can group siblings and detect cross-platform variant gaps.
 *
 * What it tries to detect:
 *   - variant_color           e.g. "Red", "Hot Pink", "Cinnamon Roll"
 *   - variant_shade           e.g. "01", "02A", "Shade 03"
 *   - variant_size            raw token, e.g. "50ml", "100 g", "30cm"
 *   - variant_volume_value    numeric, e.g. 50
 *   - variant_volume_unit     'ml' | 'g' | 'kg' | 'oz' | 'l' | 'cm' | 'mm'
 *   - variant_pack            integer count, e.g. 3 for "3 PCS" / "Set of 3"
 *   - variant_model           e.g. "iPhone 16 Pro", "V2", "Mini", "Plus"
 *   - variant_type            catch-all when nothing more specific fits
 *
 * Also returns:
 *   - extracted_tokens : every substring we lifted out, so the text normalizer
 *                        can strip them and produce a clean name_root.
 */

// ─── Vocab ──────────────────────────────────────────────────────────────────

// Compound colors first so the multi-token forms win before "pink" / "blue" do.
const COMPOUND_COLORS = [
  'hot pink', 'baby pink', 'dusty rose', 'rose gold', 'soft pink',
  'cinnamon roll', 'cherry blossom', 'dusty rose', 'wine red', 'royal blue',
  'navy blue', 'sky blue', 'midnight blue', 'ocean blue', 'forest green',
  'olive green', 'army green', 'mint green', 'lemon yellow', 'mustard yellow',
  'coral pink', 'salmon pink', 'terracotta orange', 'champagne gold',
  'pearl white', 'ivory white', 'jet black', 'matte black',
];

const COLORS = [
  'red', 'pink', 'rose', 'coral', 'peach', 'nude', 'beige', 'brown', 'tan',
  'black', 'white', 'cream', 'ivory', 'gold', 'silver', 'bronze', 'copper',
  'orange', 'apricot', 'mauve', 'plum', 'purple', 'violet', 'lavender',
  'blue', 'navy', 'teal', 'turquoise', 'green', 'olive', 'yellow', 'mustard',
  'grey', 'gray', 'charcoal', 'wine', 'burgundy', 'cherry', 'berry',
  'fuchsia', 'magenta', 'salmon', 'terracotta', 'caramel', 'chocolate',
  'cinnamon', 'mocha', 'espresso', 'champagne', 'pearl', 'opal',
  'transparent', 'clear', 'natural',
];

const MODEL_KEYWORDS = ['pro', 'mini', 'plus', 'max', 'lite', 'elite', 'ultra', 'air', 'se'];

// iPhone-specific (broader phone detection comes via the "model" pass)
const IPHONE_RE = /\biphone\s*(\d{1,2})\s*(pro\s*max|pro|plus|mini|se)?\b/i;
const SAMSUNG_RE = /\bgalaxy\s*(s\d{1,2}|note\s*\d{1,2}|a\d{1,2}|z\s*fold\d?|z\s*flip\d?)\b/i;

// Size patterns
const VOLUME_UNITS = ['ml', 'g', 'gr', 'gram', 'grams', 'kg', 'oz', 'fl oz', 'l', 'liter', 'litre', 'cm', 'mm'];
const SIZE_RE = /\b(\d+(?:[.,]\d+)?)\s?(ml|gr|gram|grams|kg|oz|fl\s?oz|cm|mm|l|liter|litre|g)\b/i;

// Pack patterns
//   "3 pcs", "set of 5", "pack of 4", "combo of 2", "2pcs", "2pk"
const PACK_RE = /\b(?:set\s+of\s+|pack\s+of\s+|combo\s+of\s+|combo\s+pack\s+of\s+)?(\d{1,2})\s?(pcs?|pieces?|pk|pack|set)\b/i;

// Shade
const SHADE_RE = /\b(?:shade|color|colour|no\.?|#)\s*(\d{1,3}[a-z]?)\b/i;
//   "01 Cinnamon Roll" — number at start optionally followed by descriptor
const STANDALONE_SHADE_RE = /^\s*(\d{1,3}[a-z]?)\s+[A-Z]/i;

// ─── Helpers ────────────────────────────────────────────────────────────────

function indexOfCi(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function normalizeVolumeUnit(unit: string): string {
  const u = unit.toLowerCase().replace(/\s+/g, '');
  if (u === 'gr' || u === 'gram' || u === 'grams') return 'g';
  if (u === 'flo' || u === 'floz') return 'oz';
  if (u === 'liter' || u === 'litre') return 'l';
  return u;
}

// ─── Output type ────────────────────────────────────────────────────────────

export type ExtractedVariantAttrs = {
  variant_color: string | null;
  variant_shade: string | null;
  variant_size: string | null;
  variant_volume_value: number | null;
  variant_volume_unit: string | null;   // 'ml' | 'g' | 'kg' | 'oz' | 'l' | 'cm' | 'mm'
  variant_pack: number | null;
  variant_model: string | null;
  variant_type: string | null;
  /** Every raw substring we captured — feed to text-normalizer to clean name_root. */
  extracted_tokens: string[];
};

// ─── Main entry point ───────────────────────────────────────────────────────

export function extractVariantAttrs(rawName: string | null | undefined): ExtractedVariantAttrs {
  const out: ExtractedVariantAttrs = {
    variant_color: null,
    variant_shade: null,
    variant_size: null,
    variant_volume_value: null,
    variant_volume_unit: null,
    variant_pack: null,
    variant_model: null,
    variant_type: null,
    extracted_tokens: [],
  };
  if (!rawName) return out;

  const name = rawName.trim();
  const lower = name.toLowerCase();

  // ─── Phone model passes first (consume multi-token strings) ────────────
  const iphoneMatch = name.match(IPHONE_RE);
  if (iphoneMatch) {
    const model = iphoneMatch[0].replace(/\s+/g, ' ').trim();
    out.variant_model = capitalize(model);
    out.extracted_tokens.push(model);
  } else {
    const samsungMatch = name.match(SAMSUNG_RE);
    if (samsungMatch) {
      out.variant_model = samsungMatch[0].trim();
      out.extracted_tokens.push(samsungMatch[0]);
    }
  }

  // ─── Compound colors (greedy first to avoid "pink" eating "hot pink") ──
  for (const c of COMPOUND_COLORS) {
    if (indexOfCi(lower, c) !== -1) {
      out.variant_color = capitalize(c);
      out.extracted_tokens.push(c);
      break;
    }
  }
  // Single-word colors
  if (!out.variant_color) {
    for (const c of COLORS) {
      const re = new RegExp(`\\b${c}\\b`, 'i');
      if (re.test(name)) {
        out.variant_color = capitalize(c);
        out.extracted_tokens.push(c);
        break;
      }
    }
  }

  // ─── Shade ──────────────────────────────────────────────────────────────
  const shadeM = name.match(SHADE_RE);
  if (shadeM) {
    out.variant_shade = shadeM[1].toUpperCase();
    out.extracted_tokens.push(shadeM[0]);
  } else {
    const standaloneM = name.match(STANDALONE_SHADE_RE);
    if (standaloneM) {
      out.variant_shade = standaloneM[1].toUpperCase();
      out.extracted_tokens.push(standaloneM[1]);
    }
  }

  // ─── Size / volume ──────────────────────────────────────────────────────
  const sizeM = name.match(SIZE_RE);
  if (sizeM) {
    const valueRaw = sizeM[1].replace(',', '.');
    const value = parseFloat(valueRaw);
    const unit = normalizeVolumeUnit(sizeM[2]);
    out.variant_size = `${valueRaw}${unit}`;
    out.variant_volume_value = Number.isFinite(value) ? value : null;
    out.variant_volume_unit = unit;
    out.extracted_tokens.push(sizeM[0]);
  }

  // ─── Pack count ─────────────────────────────────────────────────────────
  const packM = name.match(PACK_RE);
  if (packM) {
    const n = parseInt(packM[1], 10);
    if (Number.isFinite(n)) {
      out.variant_pack = n;
      out.extracted_tokens.push(packM[0]);
    }
  }

  // ─── Model keywords (Mini / Plus / Pro standalone) — only if no phone match ─
  if (!out.variant_model) {
    for (const k of MODEL_KEYWORDS) {
      const re = new RegExp(`\\b${k}\\b`, 'i');
      if (re.test(name)) {
        out.variant_model = capitalize(k);
        out.extracted_tokens.push(k);
        break;
      }
    }
  }

  // ─── Catch-all variant_type ─────────────────────────────────────────────
  // If we caught only one specific variant, mirror it into variant_type so the
  // UI/grouping can always count on at least one populated variant column.
  if (out.variant_color) out.variant_type = `Color: ${out.variant_color}`;
  else if (out.variant_shade) out.variant_type = `Shade: ${out.variant_shade}`;
  else if (out.variant_size) out.variant_type = `Size: ${out.variant_size}`;
  else if (out.variant_pack) out.variant_type = `Pack: ${out.variant_pack} pcs`;
  else if (out.variant_model) out.variant_type = `Model: ${out.variant_model}`;

  return out;
}

function capitalize(s: string): string {
  return s
    .split(' ')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/**
 * Build a deterministic "variant key" used to fingerprint a variant inside
 * its parent family. Two products in the same family with the same key are
 * considered the same variant; different keys = different variants.
 *
 * The key is composed in priority order:
 *   color > shade > volume > pack > model > "default"
 */
export function variantKey(attrs: ExtractedVariantAttrs): string {
  const parts: string[] = [];
  if (attrs.variant_color) parts.push(`color:${attrs.variant_color.toLowerCase()}`);
  if (attrs.variant_shade) parts.push(`shade:${attrs.variant_shade}`);
  if (attrs.variant_volume_value != null && attrs.variant_volume_unit) {
    parts.push(`vol:${attrs.variant_volume_value}${attrs.variant_volume_unit}`);
  }
  if (attrs.variant_pack) parts.push(`pack:${attrs.variant_pack}`);
  if (attrs.variant_model) parts.push(`model:${attrs.variant_model.toLowerCase()}`);
  if (parts.length === 0) return 'default';
  return parts.join('|');
}

/**
 * Human-readable label for variant findings UI.
 *   { variant_color: 'Black' }       → "Black"
 *   { variant_size: '50ml' }         → "50ml"
 *   { variant_color: 'Red', size: '50ml' } → "Red, 50ml"
 */
export function variantLabel(attrs: ExtractedVariantAttrs): string {
  const parts: string[] = [];
  if (attrs.variant_color) parts.push(attrs.variant_color);
  if (attrs.variant_shade) parts.push(`Shade ${attrs.variant_shade}`);
  if (attrs.variant_size) parts.push(attrs.variant_size);
  if (attrs.variant_pack) parts.push(`${attrs.variant_pack} pcs`);
  if (attrs.variant_model) parts.push(attrs.variant_model);
  return parts.length > 0 ? parts.join(', ') : 'default';
}
