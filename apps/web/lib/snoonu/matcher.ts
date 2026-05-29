/**
 * Existing-product matcher — Phase 13.6.
 *
 * Given an ExtractedProduct (from Snoonu), find the most likely existing
 * product in our `products` table, so we never blindly create duplicates.
 *
 * Match signals (in priority order):
 *   1. Exact SKU match            → confidence 1.00  (definitive)
 *   2. Exact barcode match        → confidence 0.98  (definitive)
 *   3. Source URL already linked  → confidence 0.97  (already imported)
 *   4. Image hash match           → confidence 0.92  (same canonical image)
 *   5. Exact name match           → confidence 0.85
 *   6. Brand + normalized name    → confidence 0.78
 *   7. Brand + name + price       → confidence 0.75
 *   8. Fuzzy name (Levenshtein)   → confidence 0.55..0.70
 *
 * Returns:
 *   - { kind: 'exact', existing: ProductRow, confidence, signal }
 *   - { kind: 'likely', existing: ProductRow, confidence, signal }
 *   - { kind: 'maybe',  candidates: [...], confidence }
 *   - { kind: 'new' }
 *
 * The review UI uses `kind` to decide whether to:
 *   - Auto-merge (exact)
 *   - Pre-select but show warning (likely)
 *   - Show candidate list (maybe)
 *   - Pre-fill the "create new" form (new)
 */

import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { ExtractedProduct } from '@/lib/snoonu/extractor';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Subset of the products table columns we need for matching.
 * Brand/category come through as FK ids — the matcher joins via separate lookups
 * if it ever needs the names. For now we score on name + price + sku + barcode.
 */
export type ProductRow = {
  id: number;
  master_sku: string;
  barcode: string | null;
  brand_id: number | null;
  product_name_en: string | null;
  product_name_ar: string | null;
  price: number | null;
  category_id: number | null;
  image_url: string | null;
  snoonu_url: string | null;
};

export type MatchSignal =
  | 'sku'
  | 'barcode'
  | 'source_url'
  | 'image'
  | 'name_exact'
  | 'brand_name'
  | 'brand_name_price'
  | 'fuzzy_name';

export type MatchResult =
  | { kind: 'exact'; existing: ProductRow; confidence: number; signal: MatchSignal }
  | { kind: 'likely'; existing: ProductRow; confidence: number; signal: MatchSignal; alternatives?: ProductRow[] }
  | { kind: 'maybe'; candidates: Array<{ row: ProductRow; confidence: number; signal: MatchSignal }>; confidence: number }
  | { kind: 'new'; confidence: 0 };

// ─── Normalization ──────────────────────────────────────────────────────────

function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')          // strip diacritics
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ') // keep letters/digits/Arabic
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance — caps at threshold for early exit. */
function levenshtein(a: string, b: string, max = 8): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const dist = levenshtein(a, b, Math.max(a.length, b.length));
  const len = Math.max(a.length, b.length);
  return len === 0 ? 1 : 1 - dist / len;
}

// ─── Match passes ───────────────────────────────────────────────────────────

async function matchBySku(sku: string): Promise<ProductRow | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from('products')
    .select('id, master_sku, barcode, brand_id, product_name_en, product_name_ar, price, category_id, image_url, snoonu_url')
    .eq('master_sku', sku.toUpperCase())
    .maybeSingle();
  return (data as ProductRow | null) ?? null;
}

async function matchByBarcode(barcode: string): Promise<ProductRow | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from('products')
    .select('id, master_sku, barcode, brand_id, product_name_en, product_name_ar, price, category_id, image_url, snoonu_url')
    .eq('barcode', barcode.trim())
    .maybeSingle();
  return (data as ProductRow | null) ?? null;
}

async function matchBySourceUrl(url: string): Promise<ProductRow | null> {
  const admin = createAdminSupabaseClient();
  // Try direct snoonu_url on products first
  const { data: direct } = await admin
    .from('products')
    .select('id, master_sku, barcode, brand_id, product_name_en, product_name_ar, price, category_id, image_url, snoonu_url')
    .eq('snoonu_url', url)
    .maybeSingle();
  if (direct) return direct as ProductRow;

  // Fall back to product_source_links audit table
  const { data: link } = await admin
    .from('product_source_links')
    .select('master_sku')
    .eq('source_platform', 'snoonu')
    .eq('source_url', url)
    .maybeSingle();
  if (!link) return null;

  return matchBySku((link as { master_sku: string }).master_sku);
}

async function loadCandidatesByBrand(brandName: string): Promise<ProductRow[]> {
  const admin = createAdminSupabaseClient();
  // Resolve brand id from brand name (case-insensitive)
  const { data: brandRow } = await admin
    .from('brands')
    .select('id')
    .ilike('name', brandName)
    .maybeSingle();
  if (!brandRow) return [];
  const { data } = await admin
    .from('products')
    .select('id, master_sku, barcode, brand_id, product_name_en, product_name_ar, price, category_id, image_url, snoonu_url')
    .eq('brand_id', (brandRow as { id: number }).id)
    .limit(50);
  return (data ?? []) as ProductRow[];
}

async function loadCandidatesByName(nameLike: string): Promise<ProductRow[]> {
  const admin = createAdminSupabaseClient();
  // Use trigram-like ilike — Supabase Postgres can extend with pg_trgm later.
  const { data } = await admin
    .from('products')
    .select('id, master_sku, barcode, brand_id, product_name_en, product_name_ar, price, category_id, image_url, snoonu_url')
    .or(`product_name_en.ilike.%${nameLike}%,product_name_ar.ilike.%${nameLike}%`)
    .limit(50);
  return (data ?? []) as ProductRow[];
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function matchExistingProduct(extracted: ExtractedProduct): Promise<MatchResult> {
  // 1. SKU exact
  if (extracted.sku) {
    const bySku = await matchBySku(extracted.sku);
    if (bySku) return { kind: 'exact', existing: bySku, confidence: 1.0, signal: 'sku' };
  }

  // 2. Barcode exact
  if (extracted.barcode) {
    const byBarcode = await matchByBarcode(extracted.barcode);
    if (byBarcode) return { kind: 'exact', existing: byBarcode, confidence: 0.98, signal: 'barcode' };
  }

  // 3. Source URL already imported
  const byUrl = await matchBySourceUrl(extracted.source_url);
  if (byUrl) return { kind: 'exact', existing: byUrl, confidence: 0.97, signal: 'source_url' };

  // 4. Build candidate pool from brand + name
  const candidates = new Map<number, ProductRow>();
  let brandId: number | null = null;

  if (extracted.brand) {
    const admin = createAdminSupabaseClient();
    const { data: brandRow } = await admin
      .from('brands')
      .select('id')
      .ilike('name', extracted.brand)
      .maybeSingle();
    if (brandRow) brandId = (brandRow as { id: number }).id;

    const brandHits = await loadCandidatesByBrand(extracted.brand);
    for (const r of brandHits) candidates.set(r.id, r);
  }
  if (extracted.name_en) {
    const nameFrag = extracted.name_en.split(/\s+/).slice(0, 4).join(' ');
    if (nameFrag.length >= 4) {
      const nameHits = await loadCandidatesByName(nameFrag);
      for (const r of nameHits) candidates.set(r.id, r);
    }
  }
  if (extracted.name_ar) {
    const nameFragAr = extracted.name_ar.trim().slice(0, 30);
    if (nameFragAr.length >= 4) {
      const nameHits = await loadCandidatesByName(nameFragAr);
      for (const r of nameHits) candidates.set(r.id, r);
    }
  }

  if (candidates.size === 0) {
    return { kind: 'new', confidence: 0 };
  }

  // 5. Score every candidate
  const scored = scoreCandidates(extracted, [...candidates.values()], brandId);

  if (scored.length === 0) return { kind: 'new', confidence: 0 };

  // 6. Decide kind based on top score
  const top = scored[0];

  if (top.confidence >= 0.92) {
    return {
      kind: 'exact',
      existing: top.row,
      confidence: top.confidence,
      signal: top.signal,
    };
  }
  if (top.confidence >= 0.75) {
    const rest = scored.slice(1, 4).map((s) => s.row);
    return {
      kind: 'likely',
      existing: top.row,
      confidence: top.confidence,
      signal: top.signal,
      alternatives: rest,
    };
  }
  if (top.confidence >= 0.5) {
    return {
      kind: 'maybe',
      candidates: scored.slice(0, 5),
      confidence: top.confidence,
    };
  }
  return { kind: 'new', confidence: 0 };
}

function scoreCandidates(
  extracted: ExtractedProduct,
  rows: ProductRow[],
  brandIdForExtractedBrand: number | null,
): Array<{ row: ProductRow; confidence: number; signal: MatchSignal }> {
  const eName = normalizeName(extracted.name_en);
  const eNameAr = normalizeName(extracted.name_ar);
  const ePrice = extracted.price;

  const out: Array<{ row: ProductRow; confidence: number; signal: MatchSignal }> = [];

  for (const row of rows) {
    const rName = normalizeName(row.product_name_en);
    const rNameAr = normalizeName(row.product_name_ar);

    // Exact name match
    if (eName && (eName === rName || eName === rNameAr)) {
      out.push({ row, confidence: 0.85, signal: 'name_exact' });
      continue;
    }
    if (eNameAr && (eNameAr === rNameAr || eNameAr === rName)) {
      out.push({ row, confidence: 0.85, signal: 'name_exact' });
      continue;
    }

    // Brand + name similarity
    const brandHit = brandIdForExtractedBrand != null && row.brand_id === brandIdForExtractedBrand;
    const nameSim = Math.max(
      eName && rName ? similarityRatio(eName, rName) : 0,
      eName && rNameAr ? similarityRatio(eName, rNameAr) : 0,
      eNameAr && rNameAr ? similarityRatio(eNameAr, rNameAr) : 0,
    );

    if (brandHit && nameSim >= 0.85) {
      // Boost when price also matches within 10%
      const priceClose =
        ePrice != null &&
        row.price != null &&
        Math.abs(ePrice - row.price) / Math.max(ePrice, row.price) <= 0.1;
      if (priceClose) {
        out.push({ row, confidence: 0.78, signal: 'brand_name_price' });
      } else {
        out.push({ row, confidence: 0.72, signal: 'brand_name' });
      }
      continue;
    }

    // Fuzzy name only
    if (nameSim >= 0.7) {
      const conf = 0.5 + (nameSim - 0.7) * 1.0;
      out.push({ row, confidence: Math.min(0.7, conf + 0.1), signal: 'fuzzy_name' });
    }
  }

  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

// ─── Image hash matcher (perceptual, optional) ──────────────────────────────

/**
 * Compute a simple 8x8 average-hash from raw image bytes.
 * Returns a 64-char hex string (16 hex chars actually — 64 bits).
 * Not pixel-perfect — designed for "same product photo, different CDN" matching.
 *
 * This is intentionally placed in the matcher rather than image-pull, because
 * it's a recognition concern, not a storage concern.
 *
 * Edge runtime: no `sharp`. We decode just enough JPEG/PNG header to read
 * a thumbnail. For now this is a stub returning null — wire up after the
 * core flow is verified end-to-end with name+barcode matching.
 */
export function computeImageHash(_buf: Uint8Array): string | null {
  // TODO: integrate `@cf-wasm/photon` or similar edge-safe image decoder
  return null;
}

/** Hamming distance between two hex hashes. Returns -1 if invalid. */
export function hashHamming(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return -1;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
