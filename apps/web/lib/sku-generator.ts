/**
 * SKU generator for Malika's Universe.
 *
 * Format: `MK-{CATEGORY}-{SEQ4}`
 * Examples:
 *   MK-SKIN-0001
 *   MK-MAKEUP-0007
 *   MK-BODY-0012
 *
 * Variants append a normalized suffix:
 *   MK-SKIN-0001-RED       (color)
 *   MK-MAKEUP-0007-01      (shade)
 *   MK-BODY-0012-50ML      (size)
 *   MK-GIFTS-0003-SET3     (bundle)
 *
 * Rules:
 *   - All uppercase.
 *   - No spaces. Non-alphanumeric → '-'.
 *   - SKU prefix is locked to the 11 master categories (see master-categories.ts).
 *   - Sequence is per-category, padded to 4 digits, increments forever.
 *   - Variant code is normalized from variant_value: trim, uppercase, ascii-safe.
 */
import { createAdminSupabaseClient } from '@/lib/supabase/server';

// ─── Category → prefix mapping (locked) ─────────────────────────────────────
// Must match the 11 categories in master-categories.ts.
export const CATEGORY_SKU_PREFIX: Record<string, string> = {
  'Korean Skincare': 'SKIN',
  'Makeup': 'MAKEUP',
  'Hair Care': 'HAIR',
  'Body Care': 'BODY',
  'Perfumes': 'PERFUME',
  'Beauty Tools': 'TOOLS',
  'Bags & Accessories': 'BAGS',
  'Gifts & Sets': 'GIFTS',
  'Kids & Toys': 'KIDS',
  'Thai Products': 'THAI',
  'Trending Products': 'TREND',
};

const SKU_BRAND_PREFIX = 'MK';
const SEQ_PAD = 4;

// ─── Slug helpers ───────────────────────────────────────────────────────────

/**
 * Normalize a value for SKU use:
 *   - Trim, uppercase
 *   - Remove Arabic chars (only Latin in SKU)
 *   - Replace any non-alphanumeric with '-'
 *   - Collapse consecutive '-'
 *   - Strip leading/trailing '-'
 *   - Limit to 12 chars
 */
export function normalizeSkuSegment(value: string, maxLen = 12): string {
  return value
    .normalize('NFKD')
    .replace(/[؀-ۿ]/g, '')      // strip Arabic
    .replace(/[^A-Za-z0-9]+/g, '-')        // non-alnum → dash
    .replace(/^-+|-+$/g, '')               // trim dashes
    .toUpperCase()
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}

/**
 * Build a SKU prefix for a category.
 *   "Korean Skincare" → "MK-SKIN"
 *   "Body Care"       → "MK-BODY"
 * Unknown category falls back to "MK-MISC".
 */
export function skuPrefixForCategory(categoryName: string): string {
  const code = CATEGORY_SKU_PREFIX[categoryName] ?? 'MISC';
  return `${SKU_BRAND_PREFIX}-${code}`;
}

/** Pad a sequence number to 4 digits: 1 → "0001", 23 → "0023". */
export function padSeq(n: number): string {
  return String(n).padStart(SEQ_PAD, '0');
}

// ─── Sequence resolver ──────────────────────────────────────────────────────

/**
 * Find the next sequence number for a given SKU prefix by scanning existing
 * products. Returns 1 if none exist.
 *
 * Race safety: callers should treat this as a hint, then attempt INSERT and
 * retry on unique-constraint violation. For now we rely on operator-driven
 * imports (low concurrency) — the race is acceptable.
 */
export async function nextSequenceForPrefix(skuPrefix: string): Promise<number> {
  const admin = createAdminSupabaseClient();
  // Match any SKU starting with `${skuPrefix}-` followed by digits
  const pattern = `${skuPrefix}-%`;
  const { data, error } = await admin
    .from('products')
    .select('master_sku')
    .ilike('master_sku', pattern)
    .order('master_sku', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[sku] failed to list existing SKUs:', error.message);
    return 1;
  }

  // Also check pending generated SKUs in snoonu_import_items
  const { data: pending } = await admin
    .from('snoonu_import_items')
    .select('generated_sku')
    .ilike('generated_sku', pattern)
    .not('generated_sku', 'is', null);

  const allSkus = [
    ...(data ?? []).map((r) => (r as { master_sku: string }).master_sku),
    ...(pending ?? []).map((r) => (r as { generated_sku: string | null }).generated_sku || ''),
  ];

  let maxSeq = 0;
  const re = new RegExp(`^${skuPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)(?:-|$)`);
  for (const sku of allSkus) {
    const m = re.exec(sku);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxSeq) maxSeq = n;
    }
  }
  return maxSeq + 1;
}

// ─── Main generators ────────────────────────────────────────────────────────

/**
 * Generate a NEW parent SKU for a given category.
 *   generateParentSku("Korean Skincare") → "MK-SKIN-0001"
 */
export async function generateParentSku(categoryName: string): Promise<string> {
  const prefix = skuPrefixForCategory(categoryName);
  const seq = await nextSequenceForPrefix(prefix);
  return `${prefix}-${padSeq(seq)}`;
}

/**
 * Generate a VARIANT SKU from a parent SKU + variant info.
 *   parent: "MK-MAKEUP-0001"  variantValue: "Red"  → "MK-MAKEUP-0001-RED"
 *   parent: "MK-MAKEUP-0001"  variantValue: "01"   → "MK-MAKEUP-0001-01"
 *   parent: "MK-BODY-0012"    variantValue: "50ml" → "MK-BODY-0012-50ML"
 *
 * If `existingCode` is provided (already normalized), use it directly.
 * Otherwise normalize from variantValue.
 */
export function generateVariantSku(
  parentSku: string,
  variantValue: string,
  existingCode?: string | null,
): string {
  const code = existingCode?.trim() || normalizeSkuSegment(variantValue);
  if (!code) {
    throw new Error(`Cannot generate variant SKU: variantValue "${variantValue}" produced empty code`);
  }
  return `${parentSku}-${code}`;
}

/**
 * Pick the right variant-code convention based on variant_type.
 * Used by the variant detector to produce nice, predictable suffixes.
 */
export function variantCodeForType(type: string, value: string): string {
  const v = (value ?? '').trim();
  switch (type) {
    case 'color':
      // "Red" → "RED",  "Hot Pink" → "HOT-PINK"
      return normalizeSkuSegment(v);
    case 'shade':
      // "Shade 01" → "01",  "01" → "01"
      const numMatch = /(\d+[A-Z]?)/i.exec(v);
      return numMatch ? numMatch[1].toUpperCase() : normalizeSkuSegment(v);
    case 'size':
      // "50ml" → "50ML",  "100 g" → "100G"
      return v
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 8);
    case 'quantity':
    case 'bundle':
      // "Set of 3" → "SET3",  "2pcs" → "2PCS"
      const qm = /(\d+)\s*(pc|pcs|piece|pieces|set)?/i.exec(v);
      if (qm) {
        const n = qm[1];
        const u = (qm[2] ?? '').toUpperCase().replace(/PIECES?/, 'PCS');
        return u ? `${n}${u}` : `SET${n}`;
      }
      return normalizeSkuSegment(v);
    case 'scent':
    case 'model':
    case 'type':
    case 'other':
    default:
      return normalizeSkuSegment(v);
  }
}

// ─── Image filename + storage path ──────────────────────────────────────────

/**
 * Build the image filename for a SKU.
 *   "MK-SKIN-0001"             → "MK-SKIN-0001.jpg"
 *   "MK-MAKEUP-0001-RED"       → "MK-MAKEUP-0001-RED.jpg"
 *
 * Supports custom suffix for duplicates: "MK-SKIN-0001-2.jpg".
 */
export function imageFilenameForSku(sku: string, suffix?: number | string): string {
  if (suffix !== undefined && suffix !== null && suffix !== 1) {
    return `${sku}-${suffix}.jpg`;
  }
  return `${sku}.jpg`;
}

/**
 * Build the Supabase Storage path for a SKU.
 *   products/{sku-lowercase}/{SKU}.jpg
 */
export function imageStoragePathForSku(sku: string, suffix?: number | string): string {
  const folder = sku.toLowerCase();
  return `products/${folder}/${imageFilenameForSku(sku, suffix)}`;
}

// ─── Quick validators ───────────────────────────────────────────────────────

/** Is this a valid Malika SKU format? `MK-{CATEGORY}-{4DIGITS}[-{VARIANT}]` */
export function isValidMalikaSku(sku: string): boolean {
  return /^MK-[A-Z]+-\d{4}(?:-[A-Z0-9-]+)?$/.test(sku);
}

/** Extract the parent portion of a variant SKU. Returns null if not a variant. */
export function parentOfVariantSku(sku: string): string | null {
  // MK-MAKEUP-0001-RED  →  MK-MAKEUP-0001
  const m = /^(MK-[A-Z]+-\d{4})(?:-[A-Z0-9-]+)$/.exec(sku);
  return m ? m[1] : null;
}
