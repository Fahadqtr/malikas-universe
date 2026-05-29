/**
 * Snoonu catalog parsers — Phase 13D.
 *
 * Pure functions that turn raw Snoonu data sources into a structured
 * `CatalogMapping` we can save against a `platform_products` row.
 *
 * Sources supported:
 *   1. Export columns         — Menu Category / Menu Subcategory / Section /
 *                                Collection (already present in seller-portal exports)
 *   2. Manual paste           — operator pastes a breadcrumb or category page text
 *   3. Browser-read DOM blob  — Chrome MCP extracts structured data from a
 *                                Snoonu product/category page (READ-ONLY)
 *
 * Never throws. Always returns a CatalogMapping (possibly all-null) plus a
 * confidence score and a source label.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type CatalogSource = 'export_column' | 'manual_paste' | 'browser_read' | 'inferred';

export type CatalogMapping = {
  snoonu_catalog: string | null;
  snoonu_category: string | null;
  snoonu_subcategory: string | null;
  snoonu_section: string | null;
  snoonu_collection: string | null;
  snoonu_menu_path: string | null;
  snoonu_catalog_source_url: string | null;
  catalog_source: CatalogSource | null;
  catalog_confidence: number | null;
};

export type RawRow = Record<string, unknown>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function pick(row: RawRow, keys: string[]): string | null {
  for (const k of keys) {
    const direct = row[k];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    // Case-insensitive header search
    for (const headerKey of Object.keys(row)) {
      if (headerKey.toLowerCase().replace(/\s+|_/g, '') === k.toLowerCase().replace(/\s+|_/g, '')) {
        const v = row[headerKey];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

function clean(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s
    .trim()
    .replace(/^[>\-/|→»·]+|[>\-/|→»·]+$/g, '')  // strip leading/trailing breadcrumb glyphs
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t.length > 0 ? t : null;
}

function buildMenuPath(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.map((p) => clean(p ?? null)).filter((p): p is string => !!p);
  return cleaned.length > 0 ? cleaned.join(' > ') : null;
}

function emptyMapping(): CatalogMapping {
  return {
    snoonu_catalog: null,
    snoonu_category: null,
    snoonu_subcategory: null,
    snoonu_section: null,
    snoonu_collection: null,
    snoonu_menu_path: null,
    snoonu_catalog_source_url: null,
    catalog_source: null,
    catalog_confidence: null,
  };
}

// ─── Source 1: export columns ──────────────────────────────────────────────

/**
 * Try to extract catalog info from a Snoonu seller-portal export row.
 * Columns vary; we check every known variant.
 */
export function extractFromSnoonuExportRow(row: RawRow): CatalogMapping {
  const catalog = clean(pick(row, [
    'Catalog', 'catalog', 'Catalog(ReadOnly)', 'Catalog(Update)',
    'Main Category', 'main_category', 'Menu', 'menu',
  ]));
  const category = clean(pick(row, [
    'Category', 'category', 'Category(ReadOnly)', 'Category(Update)',
    'Menu Category', 'menu_category', 'Main Category',
    'Product Category', 'Branch Category',
  ]));
  const subcategory = clean(pick(row, [
    'Sub Category', 'sub_category', 'Subcategory', 'subcategory',
    'Sub Category(ReadOnly)', 'Sub Category(Update)',
    'Menu Subcategory', 'menu_subcategory', 'Child Category',
  ]));
  const section = clean(pick(row, ['Section', 'section', 'Menu Section']));
  const collection = clean(pick(row, ['Collection', 'collection']));

  const menuPath = buildMenuPath([catalog, category, subcategory, section, collection]);

  // Confidence: more fields = higher
  const filled = [catalog, category, subcategory, section, collection].filter(Boolean).length;
  let confidence: number | null = null;
  if (filled >= 3) confidence = 1.0;
  else if (filled === 2) confidence = 0.85;
  else if (filled === 1) confidence = 0.6;

  const anyFound = filled > 0;
  return {
    snoonu_catalog: catalog,
    snoonu_category: category,
    snoonu_subcategory: subcategory,
    snoonu_section: section,
    snoonu_collection: collection,
    snoonu_menu_path: menuPath,
    snoonu_catalog_source_url: null,
    catalog_source: anyFound ? 'export_column' : null,
    catalog_confidence: confidence,
  };
}

// ─── Source 2: manual paste ────────────────────────────────────────────────

/**
 * Parse a free-form pasted breadcrumb. Accepts these shapes:
 *   "Beauty > Skincare > Korean Skincare"
 *   "Beauty / Skincare / Korean"
 *   "Beauty » Skincare » Korean"
 *   "Beauty - Skincare - Korean"
 *   "Beauty\nSkincare\nKorean"
 *
 * sourceUrl is optional — if the operator also pasted the page URL we keep it.
 */
export function parseManualPaste(input: string, sourceUrl?: string | null): CatalogMapping {
  const trimmed = input.trim();
  if (!trimmed) return emptyMapping();

  const parts = trimmed
    .split(/[>/»·→|]|\s+-\s+|\r?\n/)
    .map((p) => clean(p))
    .filter((p): p is string => !!p && p.length <= 80);

  if (parts.length === 0) return emptyMapping();

  const [catalog, category, subcategory, section, collection] = [
    parts[0] ?? null,
    parts[1] ?? null,
    parts[2] ?? null,
    parts[3] ?? null,
    parts[4] ?? null,
  ];

  const filled = parts.length;
  const confidence = filled >= 3 ? 0.95 : filled === 2 ? 0.85 : 0.7;

  return {
    snoonu_catalog: catalog,
    snoonu_category: category,
    snoonu_subcategory: subcategory,
    snoonu_section: section,
    snoonu_collection: collection,
    snoonu_menu_path: buildMenuPath([catalog, category, subcategory, section, collection]),
    snoonu_catalog_source_url: sourceUrl ?? null,
    catalog_source: 'manual_paste',
    catalog_confidence: confidence,
  };
}

// ─── Source 3: browser-read DOM blob ───────────────────────────────────────

/**
 * Shape the Chrome MCP scraper sends after reading a Snoonu product detail
 * page. The scraper extracts:
 *   - breadcrumb           — array of strings, e.g. ["Beauty", "Skincare", "Korean"]
 *   - menu_label           — sidebar/menu category label if visible
 *   - category_field_value — value of the "Category" form input on edit page
 *   - section_label        — UI section the product is shown under
 *   - collection_label     — collection chip if present
 *   - page_url             — current Snoonu URL
 *
 * All fields are optional; we use whatever we got.
 */
export type BrowserDomBlob = {
  breadcrumb?: string[];
  menu_label?: string | null;
  category_field_value?: string | null;
  subcategory_field_value?: string | null;
  section_label?: string | null;
  collection_label?: string | null;
  page_url?: string | null;
};

export function parseFromBrowserDom(blob: BrowserDomBlob): CatalogMapping {
  const bc = (blob.breadcrumb ?? []).map((p) => clean(p)).filter((p): p is string => !!p);
  const catalog = bc[0] ?? clean(blob.menu_label) ?? null;
  const category = bc[1] ?? clean(blob.category_field_value) ?? null;
  const subcategory = bc[2] ?? clean(blob.subcategory_field_value) ?? null;
  const section = bc[3] ?? clean(blob.section_label) ?? null;
  const collection = bc[4] ?? clean(blob.collection_label) ?? null;

  const filled = [catalog, category, subcategory, section, collection].filter(Boolean).length;
  if (filled === 0) return { ...emptyMapping(), snoonu_catalog_source_url: blob.page_url ?? null };

  // browser_read is the most authoritative source — high baseline confidence
  const confidence = filled >= 3 ? 1.0 : filled === 2 ? 0.92 : 0.8;

  return {
    snoonu_catalog: catalog,
    snoonu_category: category,
    snoonu_subcategory: subcategory,
    snoonu_section: section,
    snoonu_collection: collection,
    snoonu_menu_path: buildMenuPath([catalog, category, subcategory, section, collection]),
    snoonu_catalog_source_url: blob.page_url ?? null,
    catalog_source: 'browser_read',
    catalog_confidence: confidence,
  };
}

// ─── Inference fallback (no real source — derived) ─────────────────────────

/**
 * Last-resort inference from a product's brand + name when no portal source
 * is available. Confidence is intentionally low to flag for review.
 */
export function inferFromProductSignals(opts: {
  brand?: string | null;
  product_name?: string | null;
  category_name?: string | null;   // already-extracted canonical category
}): CatalogMapping {
  const cat = clean(opts.category_name);
  if (!cat) return emptyMapping();
  return {
    snoonu_catalog: 'Beauty',
    snoonu_category: cat,
    snoonu_subcategory: null,
    snoonu_section: null,
    snoonu_collection: null,
    snoonu_menu_path: buildMenuPath(['Beauty', cat]),
    snoonu_catalog_source_url: null,
    catalog_source: 'inferred',
    catalog_confidence: 0.5,
  };
}

// ─── Public combined entry point ───────────────────────────────────────────

/**
 * Try every source in order of trust. Returns the first non-empty result.
 *   1. Browser DOM blob  (highest trust — actually read from Snoonu)
 *   2. Export columns
 *   3. Manual paste
 *   4. Inference fallback
 */
export function bestEffortCatalogMapping(opts: {
  raw_row?: RawRow | null;
  manual_paste?: { input: string; source_url?: string | null } | null;
  browser_blob?: BrowserDomBlob | null;
  inference_signals?: Parameters<typeof inferFromProductSignals>[0] | null;
}): CatalogMapping {
  if (opts.browser_blob) {
    const r = parseFromBrowserDom(opts.browser_blob);
    if (r.snoonu_category || r.snoonu_catalog) return r;
  }
  if (opts.raw_row) {
    const r = extractFromSnoonuExportRow(opts.raw_row);
    if (r.snoonu_category || r.snoonu_catalog) return r;
  }
  if (opts.manual_paste?.input) {
    const r = parseManualPaste(opts.manual_paste.input, opts.manual_paste.source_url);
    if (r.snoonu_category || r.snoonu_catalog) return r;
  }
  if (opts.inference_signals) {
    return inferFromProductSignals(opts.inference_signals);
  }
  return emptyMapping();
}
