/**
 * Snoonu browser snapshot extractor — Phase 13E.2.
 *
 * Pure parsers that turn a raw blob captured by Chrome MCP (or pasted by an
 * operator) into structured product data. Pure functions, no side effects.
 *
 * SAFETY:
 *   - This module only READS. It never references Snoonu's API or generates
 *     any URL that could trigger a side effect on Snoonu's side.
 *   - The shapes it produces are intended to be saved to our DB, not sent back.
 */

// ─── Public types ───────────────────────────────────────────────────────────

export type SnoonuBranch = {
  name: string;
  stock?: number | null;
  price?: number | null;
  available?: boolean | null;
};

export type SnoonuBrowserSnapshot = {
  /** Free-form page text — what `document.body.innerText` returned. */
  page_text?: string;
  /** Optional structured fields the Chrome scraper pulled by selector. */
  page_title?: string | null;
  page_url?: string | null;
  breadcrumb?: string[];
  /** Phase 13E.13 — full list of categories from "Listed in the categories: …". First = primary. */
  listed_categories?: string[];
  /** Phase 13E.13 — per-branch stock + price captured from Availability & Price tab. */
  branches?: SnoonuBranch[];
  // Field-form values (when scraped from the edit/detail view)
  product_id_field?: string | null;
  product_name_field?: string | null;
  product_name_ar_field?: string | null;
  category_field?: string | null;
  subcategory_field?: string | null;
  section_field?: string | null;
  catalog_field?: string | null;
  price_field?: string | null;
  discount_field?: string | null;
  stock_field?: string | null;
  status_field?: string | null;
  image_url_field?: string | null;
  /**
   * Raw choice/option groups as the Chrome scraper found them. Shape is
   * intentionally loose because Snoonu's UI varies by product type.
   * Each entry should have at least { name, values: string[] }.
   */
  option_groups_raw?: Array<{
    name?: string | null;
    name_ar?: string | null;
    required?: boolean;
    min_select?: number;
    max_select?: number;
    values?: Array<{
      value?: string | null;
      value_ar?: string | null;
      price_impact?: number | null;
      stock?: number | null;
      is_default?: boolean;
      is_active?: boolean;
    }>;
  }>;
  /** Raw variant SKUs if the page exposes them. */
  variants_raw?: Array<{
    variant_id?: string | null;
    name?: string | null;
    price?: number | null;
    stock?: number | null;
    is_active?: boolean;
    options?: Record<string, string>;
  }>;
};

export type ExtractedProductData = {
  snoonu_product_url: string | null;
  snoonu_product_id: string | null;
  snoonu_product_name: string | null;
  snoonu_name_ar: string | null;

  snoonu_catalog: string | null;
  snoonu_category: string | null;
  snoonu_subcategory: string | null;
  snoonu_section: string | null;
  snoonu_menu_path: string | null;
  /** Phase 13E.13 — extra categories beyond the primary. */
  snoonu_secondary_categories: string[];

  snoonu_price: number | null;
  snoonu_discount_price: number | null;
  snoonu_currency: string;

  snoonu_stock: number | null;
  snoonu_status: string | null;
  snoonu_is_visible: boolean | null;

  snoonu_image_url: string | null;
  snoonu_image_filename: string | null;

  has_options: boolean;
  option_groups: ExtractedOptionGroup[];
  variants: ExtractedVariant[];

  /** Phase 13E.13 — per-branch stock + price + availability. */
  branches: SnoonuBranch[];

  /** Per-field confidence so the UI can flag uncertain extractions. */
  confidence: number;
  extraction_notes: string[];
};

export type ExtractedOptionGroup = {
  name: string;
  name_ar: string | null;
  required: boolean;
  min_select: number;
  max_select: number;
  values: Array<{
    value: string;
    value_ar: string | null;
    price_impact: number | null;
    stock: number | null;
    is_default: boolean;
    is_active: boolean;
  }>;
};

export type ExtractedVariant = {
  variant_id: string | null;
  name: string;
  price: number | null;
  stock: number | null;
  is_active: boolean;
  options: Record<string, string>;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim().replace(/\s{2,}/g, ' ');
  return t.length > 0 ? t : null;
}

function parseNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseInt32(v: unknown): number | null {
  const n = parseNumber(v);
  return n == null ? null : Math.trunc(n);
}

function buildMenuPath(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.map((p) => clean(p ?? null)).filter((p): p is string => !!p);
  return cleaned.length > 0 ? cleaned.join(' > ') : null;
}

/** Best-effort image filename from URL. */
function filenameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split('/');
    const last = parts[parts.length - 1] || null;
    return last && last.length > 0 ? last.split('?')[0]! : null;
  } catch {
    return null;
  }
}

// ─── Status normalization ──────────────────────────────────────────────────

function normalizeStatus(raw: string | null): { status: string | null; visible: boolean | null } {
  if (!raw) return { status: null, visible: null };
  const v = raw.toLowerCase().trim();
  if (['active', 'published', 'live', 'enabled', 'visible', 'on'].includes(v))
    return { status: 'active', visible: true };
  if (['inactive', 'unpublished', 'disabled', 'hidden', 'off', 'paused'].includes(v))
    return { status: 'inactive', visible: false };
  if (['draft', 'pending'].includes(v)) return { status: 'draft', visible: false };
  return { status: raw, visible: null };
}

// ─── Page-text fallback parsers ────────────────────────────────────────────
// When Chrome MCP only provides raw page_text, try to pull values out of it.

const PRICE_RE = /\b(?:price|السعر)\s*[:\-]?\s*(?:qar|qr|ر\.?ق)?\s*([0-9]+(?:[.,][0-9]+)?)/i;
const STOCK_RE = /\b(?:stock|inventory|qty|quantity|الكمية)\s*[:\-]?\s*([0-9]+)/i;
const ID_RE = /\b(?:product\s*id|spi|sku|code)\s*[:\-]?\s*([A-Za-z0-9\-_]+)/i;

function extractFromPageText(text: string): Partial<ExtractedProductData> {
  const out: Partial<ExtractedProductData> = {};
  const priceM = text.match(PRICE_RE);
  if (priceM) out.snoonu_price = parseNumber(priceM[1]);
  const stockM = text.match(STOCK_RE);
  if (stockM) out.snoonu_stock = parseInt32(stockM[1]);
  const idM = text.match(ID_RE);
  if (idM) out.snoonu_product_id = idM[1];
  return out;
}

// ─── Option groups normalizer ──────────────────────────────────────────────

function normalizeOptionGroups(
  raw: NonNullable<SnoonuBrowserSnapshot['option_groups_raw']>,
): { groups: ExtractedOptionGroup[]; has_options: boolean } {
  if (!raw || raw.length === 0) return { groups: [], has_options: false };

  const groups: ExtractedOptionGroup[] = [];
  for (const g of raw) {
    const name = clean(g.name);
    if (!name) continue;
    const values = (g.values ?? [])
      .map((v) => {
        const value = clean(v.value);
        if (!value) return null;
        return {
          value,
          value_ar: clean(v.value_ar),
          price_impact: parseNumber(v.price_impact),
          stock: parseInt32(v.stock),
          is_default: !!v.is_default,
          is_active: v.is_active !== false, // default true
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (values.length === 0) continue;

    groups.push({
      name,
      name_ar: clean(g.name_ar),
      required: !!g.required,
      min_select: g.min_select ?? 0,
      max_select: g.max_select ?? values.length,
      values,
    });
  }

  return { groups, has_options: groups.length > 0 };
}

function normalizeVariants(
  raw: NonNullable<SnoonuBrowserSnapshot['variants_raw']>,
): ExtractedVariant[] {
  if (!raw || raw.length === 0) return [];
  const out: ExtractedVariant[] = [];
  for (const v of raw) {
    const name = clean(v.name);
    if (!name) continue;
    out.push({
      variant_id: clean(v.variant_id),
      name,
      price: parseNumber(v.price),
      stock: parseInt32(v.stock),
      is_active: v.is_active !== false,
      options: v.options ?? {},
    });
  }
  return out;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Extract structured product data from a browser snapshot.
 *
 * Priority: structured fields > page_text fallbacks. Returns a fully-populated
 * shape with nulls where data wasn't available; never throws.
 */
export function extractProductData(snap: SnoonuBrowserSnapshot): ExtractedProductData {
  const notes: string[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;

  function record(weight: number, ok: boolean) {
    confidenceCount += weight;
    if (ok) confidenceSum += weight;
  }

  // ─── Core identity ────────────────────────────────────────────────────
  const url = clean(snap.page_url);
  const productId = clean(snap.product_id_field);
  const name = clean(snap.product_name_field) ?? clean(snap.page_title);
  const nameAr = clean(snap.product_name_ar_field);

  record(2, !!name);
  record(1, !!url);
  record(1, !!productId);

  // ─── Catalog hierarchy ────────────────────────────────────────────────
  // Phase 13E.13: prefer the structured `listed_categories` list when the
  // Chrome scraper read the "Listed in the categories: ..." line. First entry
  // becomes the primary category; the rest are secondary (cross-listings).
  const listed = (snap.listed_categories ?? [])
    .map((c) => clean(c))
    .filter((c): c is string => !!c);
  const bc = (snap.breadcrumb ?? []).map((p) => clean(p)).filter((p): p is string => !!p);

  // Primary fields prefer the field-by-field selector data, falling back to
  // breadcrumb, then listed_categories.
  const catalog = clean(snap.catalog_field) ?? bc[0] ?? listed[0] ?? null;
  const category = clean(snap.category_field) ?? bc[1] ?? listed[0] ?? catalog;
  const subcategory = clean(snap.subcategory_field) ?? bc[2] ?? null;
  const section = clean(snap.section_field) ?? bc[3] ?? null;

  // Phase 13E.13: secondary categories are anything in listed[] that isn't
  // the primary category.
  const secondaryCategories = listed.length > 1
    ? listed.slice(1).filter((c) => c !== category)
    : [];

  // Phase 13E.13: when cross-listed, menu_path = "Cat1 | Cat2 | Cat3" so the
  // UI shows the full set in a single column.
  let menuPath: string | null;
  if (listed.length > 1) {
    // Dedupe consecutive identical levels to avoid "Electronics > Electronics"
    const dedupedListed = Array.from(new Set(listed));
    menuPath = dedupedListed.join(' | ');
  } else {
    const parts = [catalog, category, subcategory, section].filter((v): v is string => !!v);
    const deduped: string[] = [];
    for (const p of parts) {
      if (deduped[deduped.length - 1] !== p) deduped.push(p);
    }
    menuPath = deduped.length > 0 ? deduped.join(' > ') : null;
  }

  record(2, !!category);
  record(1, !!catalog);
  record(1, listed.length > 1); // bonus for multi-category capture

  // ─── Branches (Phase 13E.13) ─────────────────────────────────────────
  // Normalize the per-branch list from the snapshot. We accept any branch
  // with at least a name; missing stock/price stays null.
  const branches: SnoonuBranch[] = (snap.branches ?? [])
    .map((b) => {
      const name = clean(b.name);
      if (!name) return null;
      return {
        name,
        stock: parseInt32(b.stock),
        price: parseNumber(b.price),
        available: b.available ?? null,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  // ─── Pricing ──────────────────────────────────────────────────────────
  // Prefer explicit price_field; otherwise derive from branches (most common
  // case for Snoonu where price lives per-branch). If all branch prices match,
  // use that single value. If they differ, use the maximum (most listed).
  let price = parseNumber(snap.price_field);
  if (price == null && branches.length > 0) {
    const branchPrices = branches.map((b) => b.price).filter((p): p is number => p != null);
    if (branchPrices.length > 0) {
      const unique = Array.from(new Set(branchPrices));
      price = unique.length === 1 ? unique[0]! : Math.max(...branchPrices);
      if (unique.length > 1) notes.push(`price_varies_across_branches:${unique.join(',')}`);
    }
  }
  if (price == null && snap.page_text) {
    const fromText = extractFromPageText(snap.page_text);
    price = fromText.snoonu_price ?? null;
    if (price != null) notes.push('price_from_page_text');
  }
  const discount = parseNumber(snap.discount_field);

  record(2, price != null);

  // ─── Inventory ────────────────────────────────────────────────────────
  // Sum branch stocks if available; falls back to stock_field, then page_text.
  let stock = parseInt32(snap.stock_field);
  if (stock == null && branches.length > 0) {
    const total = branches.reduce(
      (acc, b) => acc + (b.stock != null ? b.stock : 0),
      0,
    );
    const anyHasStock = branches.some((b) => b.stock != null);
    stock = anyHasStock ? total : null;
  }
  if (stock == null && snap.page_text) {
    const fromText = extractFromPageText(snap.page_text);
    stock = fromText.snoonu_stock ?? null;
    if (stock != null) notes.push('stock_from_page_text');
  }
  const { status, visible } = normalizeStatus(clean(snap.status_field));

  // Status: if not explicitly set, derive from branches.available
  let finalStatus = status;
  if (finalStatus == null && branches.length > 0) {
    const anyAvailable = branches.some((b) => b.available === true);
    finalStatus = anyAvailable ? 'active' : 'inactive';
  }

  record(1, stock != null);
  record(1, finalStatus !== null);
  record(1, branches.length > 0); // bonus for branch capture

  // ─── Image ────────────────────────────────────────────────────────────
  const imageUrl = clean(snap.image_url_field);
  const imageFilename = filenameFromUrl(imageUrl);
  record(1, !!imageUrl);

  // ─── Options & variants ───────────────────────────────────────────────
  const { groups: optionGroups, has_options: hasOptions } = normalizeOptionGroups(
    snap.option_groups_raw ?? [],
  );
  const variants = normalizeVariants(snap.variants_raw ?? []);

  if (hasOptions) notes.push(`options:${optionGroups.length}_groups`);
  if (variants.length > 0) notes.push(`variants:${variants.length}`);

  // ─── Confidence rollup ────────────────────────────────────────────────
  const confidence = confidenceCount === 0 ? 0 : Number((confidenceSum / confidenceCount).toFixed(2));

  return {
    snoonu_product_url: url,
    snoonu_product_id: productId,
    snoonu_product_name: name,
    snoonu_name_ar: nameAr,
    snoonu_catalog: catalog,
    snoonu_category: category,
    snoonu_subcategory: subcategory,
    snoonu_section: section,
    snoonu_menu_path: menuPath,
    snoonu_secondary_categories: secondaryCategories,
    snoonu_price: price,
    snoonu_discount_price: discount,
    snoonu_currency: 'QAR',
    snoonu_stock: stock,
    snoonu_status: finalStatus,
    snoonu_is_visible: visible,
    snoonu_image_url: imageUrl,
    snoonu_image_filename: imageFilename,
    has_options: hasOptions,
    option_groups: optionGroups,
    variants,
    branches,
    confidence,
    extraction_notes: notes,
  };
}

/**
 * Soft sanity check: does this snapshot have enough data to be worth saving?
 * Used by the API to refuse empty/garbage payloads.
 */
export function snapshotIsUsable(snap: SnoonuBrowserSnapshot): boolean {
  if (!snap) return false;
  const hasAnyField =
    !!snap.product_name_field ||
    !!snap.page_title ||
    !!snap.page_url ||
    (Array.isArray(snap.breadcrumb) && snap.breadcrumb.length > 0) ||
    !!snap.category_field ||
    !!snap.price_field ||
    (typeof snap.page_text === 'string' && snap.page_text.trim().length > 20);
  return hasAnyField;
}
