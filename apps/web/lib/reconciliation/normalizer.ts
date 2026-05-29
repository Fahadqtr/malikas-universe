/**
 * Platform column normalizer — Phase 13A.
 *
 * Different platforms ship their product exports with different column names.
 * This module turns any of them into a unified shape (`NormalizedProductRow`)
 * so the comparator can work on a single representation.
 *
 * Supported platforms:
 *   - snoonu     (own export or scraped)
 *   - talabat    (merchant portal export)
 *   - rafeeq     (vendor export)
 *   - shopify    (products CSV export)
 *   - internal   (our own master sheet export)
 *
 * Inputs:
 *   - Array of objects (rows) with raw column names as keys
 *   - Header names (for platform detection)
 *
 * Outputs:
 *   - { platform, rows: NormalizedProductRow[], detected_headers, column_mapping }
 *
 * Detection strategy:
 *   1. If a hint platform is passed, use it.
 *   2. Otherwise score every platform's signature against the headers; pick best.
 *   3. If nothing scores above the threshold, return 'other' and let the operator
 *      pick the platform manually in the UI.
 */

export type Platform = 'snoonu' | 'talabat' | 'rafeeq' | 'shopify' | 'internal' | 'other';

export type NormalizedProductRow = {
  source_row_index: number;
  source_product_id: string | null;
  source_url: string | null;
  source_sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  category: string | null;
  subcategory: string | null;
  product_type: string | null;
  price: number | null;
  discount_price: number | null;
  currency: string;
  stock_quantity: number | null;
  stock_status: string | null;
  platform_status: string | null;
  image_url: string | null;
  image_filename: string | null;
  description_en: string | null;
  description_ar: string | null;
  variants: NormalizedVariant[];
  raw: Record<string, unknown>;
};

export type NormalizedVariant = {
  type: string;        // 'color' | 'size' | 'shade' | ...
  value: string;
  sku?: string | null;
  price?: number | null;
  stock?: number | null;
  image?: string | null;
};

export type NormalizationResult = {
  platform: Platform;
  rows: NormalizedProductRow[];
  detected_headers: string[];
  column_mapping: Record<string, string>;            // canonical field → which raw header was used
  prefix_mapping: Record<string, string[]>;          // canonical field → all headers matched via prefix patterns
  category_hint_headers: string[];                   // headers used as category inference hints (e.g. preparation_time)
  unmapped_headers: string[];                        // raw headers we ignored
  platform_score: number;                            // 0..1 confidence we picked the right platform
};

// ─── Platform signatures (hint headers used to detect platform) ─────────────

const PLATFORM_SIGNATURES: Record<Platform, string[]> = {
  snoonu: [
    'snoonu_sku', 'snoonu_id', 'snoonu_url',
    'product_name_en', 'product_name_ar',
    // also: 'sku','name','brand','price','category' — these are generic so we
    // only score on platform-specific identifiers
  ],
  talabat: [
    'talabat_sku', 'item_code', 'talabat_id', 'merchant_sku',
    'arabic_name', 'english_name', 'tag',
  ],
  rafeeq: [
    'rafeeq_sku', 'rafeeq_id', 'product_code', 'arabic_name',
    'english_name', 'unit_price',
  ],
  shopify: [
    'handle', 'variant sku', 'variant price', 'option1 name', 'option1 value',
    'image src', 'body (html)', 'vendor', 'product type', 'published',
  ],
  internal: [
    'master_sku', 'main_category', 'sub_category', 'platform_status',
    'shopify_status', 'snoonu_status', 'talabat_status', 'rafeeq_status',
  ],
  other: [],
};

// ─── Column maps: canonical field → list of aliases per platform ────────────
//
// Lookup is case-insensitive and normalized (spaces/underscores collapsed).
// First match wins.

type FieldMap = Record<string, string[]>;

const SNOONU_MAP: FieldMap = {
  source_product_id: [
    'snoonu_id', 'id', 'product_id', 'item_id', 'pid', 'gid', 'product id',
    'reference', 'reference id', 'reference_id',
  ],
  source_url: [
    'snoonu_url', 'url', 'link', 'product_url', 'product link', 'product page',
    'slug', 'handle',
  ],
  source_sku: [
    'snoonu_sku', 'sku', 'master_sku', 'code', 'product code', 'product_code',
    'item_code', 'item code', 'merchant sku', 'merchant_sku',
    // Snoonu seller-portal variants
    'sku(update)', 'sku(readonly)',
  ],
  barcode: [
    'barcode', 'ean', 'upc', 'gtin', 'bar code', 'bar_code',
    // Snoonu seller-portal variants
    'barcode(update)', 'barcode(readonly)',
  ],
  name_en: [
    'product_name_en', 'name_en', 'english_name', 'product_name', 'name', 'title',
    'product name', 'product (en)', 'product english', 'title (en)', 'name (en)',
    'english title', 'item name', 'item name (en)', 'product title',
    // Snoonu seller-portal variants
    'product name (en)(update)', 'product name (en)(readonly)',
    'product_name (en)(update)', 'product_name (en)(readonly)',
  ],
  name_ar: [
    'product_name_ar', 'name_ar', 'arabic_name', 'arabic name', 'name (ar)',
    'product (ar)', 'product arabic', 'title (ar)', 'arabic title',
    'item name (ar)', 'name arabic',
    // Snoonu seller-portal variants
    'product name (ar)(update)', 'product name (ar)(readonly)',
    'product_name (ar)(update)', 'product_name (ar)(readonly)',
  ],
  brand: ['brand', 'brand_name', 'manufacturer', 'brand (en)', 'brand english'],
  // Phase 13B.16: cover the 21 known Snoonu category-column header variants
  // including ReadOnly/Update suffixed variants from the seller portal export
  category: [
    // Common
    'category', 'main category', 'main_category', 'category_en', 'category name',
    'category_name', 'product category', 'product_category', 'parent category',
    'parent_category', 'menu category', 'menu_category', 'item category',
    'item_category', 'collection', 'section', 'product type', 'product_type',
    'product class', 'product_class', 'department', 'branch category',
    'branch_category', 'catalog category', 'catalog_category', 'tag', 'tags',
    // Snoonu seller-portal ReadOnly/Update variants
    'category(readonly)', 'category (readonly)', 'category(update)', 'category (update)',
    'main category(readonly)', 'main category (readonly)',
    'main category(update)', 'main category (update)',
    'main_category(readonly)', 'main_category (readonly)',
    'main_category(update)', 'main_category (update)',
  ],
  subcategory: [
    'sub_category', 'subcategory', 'sub category', 'sub-category',
    'subcategory name', 'sub category name', 'subcategory_name',
    'menu subcategory', 'menu_subcategory', 'child category', 'child_category',
    'second category', 'secondary category', 'secondary_category',
    // Snoonu seller-portal variants
    'sub category(readonly)', 'sub category (readonly)',
    'sub category(update)', 'sub category (update)',
    'sub_category(readonly)', 'sub_category (readonly)',
    'sub_category(update)', 'sub_category (update)',
    'subcategory(readonly)', 'subcategory (readonly)',
    'subcategory(update)', 'subcategory (update)',
  ],
  product_type: ['product_type', 'type', 'product type', 'item type'],
  price: [
    'price', 'unit_price', 'sell_price', 'selling_price', 'unit price',
    'selling price', 'regular price', 'list price', 'retail price',
    'price (qar)', 'price qar', 'amount',
    // Snoonu seller-portal exact form
    'price for branch',
  ],
  discount_price: [
    'discount_price', 'sale_price', 'promo_price', 'discount price', 'sale price',
    'promo price', 'special price', 'offer price', 'discounted price',
  ],
  stock_quantity: [
    'stock', 'stock_quantity', 'inventory', 'qty', 'quantity', 'available',
    'available_qty', 'stock qty', 'stock quantity',
  ],
  stock_status: ['stock_status', 'availability', 'in stock', 'in_stock', 'stock status'],
  platform_status: [
    'status', 'product_status', 'snoonu_status', 'active', 'visibility',
    'state', 'product status', 'enabled',
  ],
  image_url: [
    'image_url', 'image', 'image src', 'image link', 'photo', 'photo url',
    'photo_url', 'main image', 'primary image', 'thumbnail', 'image (url)',
  ],
  image_filename: ['image_filename', 'image_name', 'filename', 'image name'],
  description_en: [
    'description_en', 'description', 'body (html)', 'description (en)',
    'description english', 'english description', 'long description',
    'details', 'product description',
    // Snoonu seller-portal variants
    'product description (en)(update)', 'product description (en)(readonly)',
    'product_description (en)(update)', 'product_description (en)(readonly)',
  ],
  description_ar: [
    'description_ar', 'arabic_description', 'description (ar)',
    'description arabic', 'arabic details',
    // Snoonu seller-portal variants
    'product description (ar)(update)', 'product description (ar)(readonly)',
    'product_description (ar)(update)', 'product_description (ar)(readonly)',
  ],
};

// ─── Snoonu prefix-pattern columns ─────────────────────────────────────────
// Some Snoonu exports use multi-column prefix patterns like:
//   "Price For Branch <branch_name>" — one column per branch
//   "Stock For <branch_name>"
//   "Availability for <branch_name>"
// We capture them all and use the FIRST non-empty value per row.
//
// Keys are normalized prefixes (lowercased, spaces collapsed).
// Values are the canonical field they map to.
const SNOONU_PREFIX_MAP: Record<string, string> = {
  'price for branch ': 'price',
  'stock for ': 'stock_quantity',
  'availability for ': 'platform_status',
};

// Single special-case header used as a category-inference signal.
const SNOONU_CATEGORY_HINT_HEADERS = [
  'preparation time(update)', 'preparation time (update)',
  'preparation time(readonly)', 'preparation time (readonly)',
  'preparation time',
];

const TALABAT_MAP: FieldMap = {
  source_product_id: [
    'talabat_id', 'id', 'item_id', 'product_id', 'pid', 'item id', 'product id',
  ],
  source_url: ['talabat_url', 'url', 'link', 'product url'],
  source_sku: [
    'talabat_sku', 'merchant_sku', 'item_code', 'sku', 'code',
    'merchant sku', 'item code', 'product code', 'product_code',
    'reference', 'ref', 'ref code',
  ],
  barcode: ['barcode', 'ean', 'upc', 'bar code', 'gtin'],
  name_en: [
    'english_name', 'name_en', 'item_name', 'product_name', 'name', 'title',
    'item name', 'product name', 'name (en)', 'english name', 'item title',
  ],
  name_ar: [
    'arabic_name', 'name_ar', 'product_name_ar', 'arabic name', 'name (ar)',
    'item name (ar)', 'product name (ar)',
  ],
  brand: ['brand', 'brand_name', 'brand name'],
  category: [
    'category', 'main_category', 'tag', 'main category', 'menu category',
    'menu_category', 'tags',
  ],
  subcategory: ['subcategory', 'sub_tag', 'sub category', 'sub-category'],
  product_type: ['type', 'product_type', 'product type', 'item type'],
  price: [
    'price', 'unit_price', 'unit price', 'list price', 'regular price',
    'price (qar)', 'price qar', 'retail price',
  ],
  discount_price: [
    'discount_price', 'offer_price', 'promo_price', 'discount price',
    'offer price', 'promo price', 'sale price', 'special price',
  ],
  stock_quantity: [
    'stock', 'quantity', 'inventory', 'qty', 'stock_quantity',
    'available', 'in stock qty',
  ],
  stock_status: ['availability', 'stock_status', 'in stock', 'stock status'],
  platform_status: ['status', 'active', 'visibility', 'state', 'enabled'],
  image_url: ['image_url', 'image', 'photo', 'image link', 'main image', 'thumbnail'],
  image_filename: ['image_filename', 'filename', 'image name'],
  description_en: [
    'description', 'description_en', 'description (en)', 'item description',
    'product description', 'details',
  ],
  description_ar: ['description_ar', 'arabic_description', 'description (ar)'],
};

const RAFEEQ_MAP: FieldMap = {
  source_product_id: [
    'rafeeq_id', 'id', 'product_id', 'item_id', 'pid', 'product id',
  ],
  source_url: ['rafeeq_url', 'url', 'link', 'product url'],
  source_sku: [
    'rafeeq_sku', 'product_code', 'sku', 'code', 'item_code',
    'product code', 'item code', 'reference',
  ],
  barcode: ['barcode', 'ean', 'upc', 'gtin'],
  name_en: [
    'english_name', 'name_en', 'name', 'product_name', 'title',
    'english name', 'product name', 'item name', 'name (en)',
  ],
  name_ar: [
    'arabic_name', 'name_ar', 'arabic name', 'name (ar)',
    'product name (ar)', 'item name (ar)',
  ],
  brand: ['brand', 'manufacturer', 'brand name', 'brand_name'],
  category: ['category', 'main_category', 'main category', 'menu category'],
  subcategory: ['subcategory', 'sub_category', 'sub category'],
  product_type: ['type', 'product_type', 'product type'],
  price: [
    'price', 'unit_price', 'selling_price', 'unit price', 'selling price',
    'list price', 'retail price', 'price (qar)',
  ],
  discount_price: [
    'discount_price', 'sale_price', 'discount price', 'sale price',
    'offer price', 'promo price', 'special price',
  ],
  stock_quantity: ['stock', 'inventory', 'qty', 'quantity', 'available'],
  stock_status: ['availability', 'stock_status', 'in stock', 'stock status'],
  platform_status: ['status', 'active', 'state', 'enabled'],
  image_url: [
    'image_url', 'image', 'photo_url', 'photo', 'image link',
    'main image', 'thumbnail',
  ],
  image_filename: ['image_filename', 'filename', 'image name'],
  description_en: [
    'description', 'description_en', 'description (en)',
    'product description', 'item description',
  ],
  description_ar: [
    'description_ar', 'arabic_description', 'description (ar)',
    'description arabic',
  ],
};

const SHOPIFY_MAP: FieldMap = {
  source_product_id: ['id', 'product id'],
  source_url: ['handle'],                        // handle is the URL slug
  source_sku: ['variant sku', 'sku'],
  barcode: ['variant barcode', 'barcode'],
  name_en: ['title'],
  name_ar: ['title (ar)', 'arabic title'],       // if metafield exported
  brand: ['vendor'],
  category: ['product category', 'type', 'product type'],
  subcategory: ['sub category', 'tags'],
  product_type: ['product type', 'type'],
  price: ['variant price', 'price'],
  discount_price: ['variant compare at price', 'compare at price'],
  stock_quantity: ['variant inventory qty', 'inventory qty'],
  stock_status: ['variant inventory policy', 'status'],
  platform_status: ['status', 'published'],
  image_url: ['image src'],
  image_filename: ['image filename', 'image alt text'],
  description_en: ['body (html)', 'description'],
  description_ar: ['description (ar)', 'metafield: ar_description'],
};

const INTERNAL_MAP: FieldMap = {
  source_product_id: ['id'],
  source_url: ['url', 'link'],
  source_sku: ['master_sku', 'sku'],
  barcode: ['barcode'],
  name_en: ['product_name_en', 'name_en'],
  name_ar: ['product_name_ar', 'name_ar'],
  brand: ['brand'],
  category: ['main_category', 'category'],
  subcategory: ['sub_category', 'subcategory'],
  product_type: ['product_type', 'type'],
  price: ['price'],
  discount_price: ['discount_price'],
  stock_quantity: ['stock_quantity', 'stock'],
  stock_status: ['stock_status'],
  platform_status: ['product_status', 'status', 'platform_status'],
  image_url: ['image_url'],
  image_filename: ['image_filename'],
  description_en: ['description_en'],
  description_ar: ['description_ar'],
};

const FIELD_MAPS: Record<Exclude<Platform, 'other'>, FieldMap> = {
  snoonu: SNOONU_MAP,
  talabat: TALABAT_MAP,
  rafeeq: RAFEEQ_MAP,
  shopify: SHOPIFY_MAP,
  internal: INTERNAL_MAP,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalize a header for matching: lowercase, collapse spaces/underscores,
 *  preserve parentheses (for Snoonu's "Category(ReadOnly)" style headers). */
function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, ' ')
    // Snoonu sometimes uses "Category (ReadOnly)" with a space, sometimes not.
    // Normalize both forms to "category(readonly)" so a single alias matches.
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .trim();
}

/** Build a lookup index of normalized headers → original header. */
function indexHeaders(headers: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of headers) m.set(normalizeHeader(h), h);
  return m;
}

/** Find which raw header matches one of these aliases. */
function findHeader(index: Map<string, string>, aliases: string[]): string | null {
  for (const a of aliases) {
    const k = normalizeHeader(a);
    if (index.has(k)) return index.get(k)!;
  }
  return null;
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

function trimOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// ─── Platform detection ─────────────────────────────────────────────────────

export function detectPlatform(headers: string[]): { platform: Platform; score: number } {
  const index = indexHeaders(headers);
  let best: Platform = 'other';
  let bestScore = 0;

  for (const [platform, signature] of Object.entries(PLATFORM_SIGNATURES) as [Platform, string[]][]) {
    if (platform === 'other' || signature.length === 0) continue;
    let hits = 0;
    for (const sig of signature) {
      if (index.has(normalizeHeader(sig))) hits++;
    }
    const score = hits / signature.length;
    if (score > bestScore) {
      bestScore = score;
      best = platform;
    }
  }

  if (bestScore < 0.15) return { platform: 'other', score: bestScore };
  return { platform: best, score: bestScore };
}

// ─── Variant extraction (best-effort, Shopify is the main producer here) ────

function extractVariants(row: Record<string, unknown>, platform: Platform): NormalizedVariant[] {
  const variants: NormalizedVariant[] = [];
  if (platform === 'shopify') {
    // Shopify uses Option1/2/3 Name + Value columns
    for (let i = 1; i <= 3; i++) {
      const name = trimOrNull(row[`Option${i} Name`]) ?? trimOrNull(row[`option${i} name`]);
      const value = trimOrNull(row[`Option${i} Value`]) ?? trimOrNull(row[`option${i} value`]);
      if (name && value && value.toLowerCase() !== 'default title') {
        variants.push({
          type: name.toLowerCase(),
          value,
          sku: trimOrNull(row['Variant SKU']),
          price: parseNumber(row['Variant Price']),
          stock: parseInt32(row['Variant Inventory Qty']),
          image: trimOrNull(row['Image Src']),
        });
      }
    }
  }
  // Other platforms typically encode variants as separate rows — handled at
  // the comparator level by grouping by (matched_master_sku, parent_sku).
  return variants;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Normalize an array of raw row objects into the canonical shape.
 *
 * @param rows  Array of row objects (raw header → value)
 * @param opts.platform_hint  If passed, skip detection and use this platform
 */
export function normalizeRows(
  rows: Array<Record<string, unknown>>,
  opts: { platform_hint?: Platform } = {},
): NormalizationResult {
  if (rows.length === 0) {
    return {
      platform: opts.platform_hint ?? 'other',
      rows: [],
      detected_headers: [],
      column_mapping: {},
      prefix_mapping: {},
      category_hint_headers: [],
      unmapped_headers: [],
      platform_score: 0,
    };
  }

  const headers = Object.keys(rows[0]);
  const detected = opts.platform_hint
    ? { platform: opts.platform_hint, score: 1.0 }
    : detectPlatform(headers);

  const platform = detected.platform;
  const fieldMap = platform === 'other' ? null : FIELD_MAPS[platform];

  const index = indexHeaders(headers);
  const columnMapping: Record<string, string> = {};
  const usedHeaders = new Set<string>();

  // ─── Pass 1: exact alias matching ────────────────────────────────────────
  if (fieldMap) {
    for (const [field, aliases] of Object.entries(fieldMap)) {
      const found = findHeader(index, aliases);
      if (found) {
        columnMapping[field] = found;
        usedHeaders.add(found);
      }
    }
  }

  // ─── Pass 2: Snoonu prefix-pattern columns (Price For Branch *, etc.) ────
  // Each prefix captures ALL matching headers — at row-normalize time we use
  // the first non-empty value.
  const prefixMapping: Record<string, string[]> = {};
  if (platform === 'snoonu') {
    for (const [prefix, field] of Object.entries(SNOONU_PREFIX_MAP)) {
      const matches = headers.filter((h) => normalizeHeader(h).startsWith(prefix));
      if (matches.length > 0) {
        prefixMapping[field] = matches;
        for (const h of matches) usedHeaders.add(h);
      }
    }
  }

  // ─── Pass 3: category-inference hint headers (preparation time, etc.) ────
  const categoryHintHeaders: string[] = [];
  if (platform === 'snoonu') {
    for (const h of headers) {
      const n = normalizeHeader(h);
      if (SNOONU_CATEGORY_HINT_HEADERS.some((alias) => normalizeHeader(alias) === n)) {
        categoryHintHeaders.push(h);
        usedHeaders.add(h);
      }
    }
  }

  const unmapped = headers.filter((h) => !usedHeaders.has(h));

  // Map every row
  const normalized: NormalizedProductRow[] = rows.map((row, i) => {
    const get = (field: string): unknown =>
      columnMapping[field] ? row[columnMapping[field]] : undefined;

    /** Pick the first non-empty value across a list of prefix-matched headers. */
    const getPrefixValue = (field: string): unknown => {
      const candidates = prefixMapping[field];
      if (!candidates || candidates.length === 0) return undefined;
      for (const h of candidates) {
        const v = row[h];
        if (v !== null && v !== undefined && String(v).trim() !== '') return v;
      }
      return undefined;
    };

    /** Helper that prefers the exact-mapped column, falls back to prefix-matched. */
    const resolve = (field: string): unknown => {
      const direct = get(field);
      if (direct !== null && direct !== undefined && String(direct).trim() !== '') return direct;
      return getPrefixValue(field);
    };

    return {
      source_row_index: i,
      source_product_id: trimOrNull(resolve('source_product_id')),
      source_url: trimOrNull(resolve('source_url')),
      source_sku: trimOrNull(resolve('source_sku')),
      barcode: trimOrNull(resolve('barcode')),
      name_en: trimOrNull(resolve('name_en')),
      name_ar: trimOrNull(resolve('name_ar')),
      brand: trimOrNull(resolve('brand')),
      category: trimOrNull(resolve('category')),
      subcategory: trimOrNull(resolve('subcategory')),
      product_type: trimOrNull(resolve('product_type')),
      price: parseNumber(resolve('price')),
      discount_price: parseNumber(resolve('discount_price')),
      currency: 'QAR',
      stock_quantity: parseInt32(resolve('stock_quantity')),
      stock_status: trimOrNull(resolve('stock_status')),
      platform_status: trimOrNull(resolve('platform_status')),
      image_url: trimOrNull(resolve('image_url')),
      image_filename: trimOrNull(resolve('image_filename')),
      description_en: trimOrNull(resolve('description_en')),
      description_ar: trimOrNull(resolve('description_ar')),
      variants: extractVariants(row, platform),
      raw: row,
    };
  });

  return {
    platform,
    rows: normalized,
    detected_headers: headers,
    column_mapping: columnMapping,
    prefix_mapping: prefixMapping,
    category_hint_headers: categoryHintHeaders,
    unmapped_headers: unmapped,
    platform_score: detected.score,
  };
}

/**
 * Quick check: does a normalized row carry the minimum info needed to be
 * compared at all? (Either a SKU, a barcode, or both names.)
 */
export function rowIsComparable(row: NormalizedProductRow): boolean {
  return Boolean(row.source_sku || row.barcode || row.name_en || row.name_ar);
}
