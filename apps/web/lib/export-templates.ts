/**
 * Marketplace export templates.
 *
 * Each platform has its own:
 *   • column order
 *   • column names (sometimes Arabic, sometimes English)
 *   • required vs optional fields
 *   • value transforms (e.g. price as string, stock as number)
 *
 * Adding a new platform = add an entry to PLATFORMS. The rest of the
 * pipeline (preview, validate, generate, history) is data-driven.
 *
 * Source product shape comes from products table + brand/category embeds
 * (matches ProductsService.findBySku / list output).
 */

export type ExportTarget = 'snoonu' | 'talabat' | 'rafeeq' | 'shopify';

export type SourceProduct = {
  master_sku: string;
  barcode?: string | null;
  product_name_en?: string | null;
  product_name_ar?: string | null;
  product_type?: string | null;
  variant?: string | null;
  color?: string | null;
  size?: string | null;
  price?: number | null;
  discount_price?: number | null;
  cost?: number | null;
  stock_quantity?: number | null;
  stock_status?: string | null;
  product_status?: string | null;
  description_en?: string | null;
  description_ar?: string | null;
  usage_en?: string | null;
  usage_ar?: string | null;
  keywords_en?: string[] | null;
  keywords_ar?: string[] | null;
  image_url?: string | null;
  brand?: { id: number; name: string; name_ar?: string | null } | null;
  category?: { id: number; name: string; name_ar?: string | null } | null;
};

export type ColumnDef = {
  /** column header (becomes the CSV/XLSX header row) */
  header: string;
  /** machine field id (used for validator + history) */
  field: string;
  /** is this column required to publish on the target platform? */
  required: boolean;
  /** value extractor — pure, no side effects */
  value: (p: SourceProduct) => string | number | null;
  /** optional hint for missing-field message */
  hint?: string;
};

export type PlatformTemplate = {
  id: ExportTarget;
  label: string;
  description: string;
  /** ordered columns — exact order in output file */
  columns: ColumnDef[];
};

// ─── Shared value extractors ────────────────────────────────────────────────

const join = (arr: string[] | null | undefined, sep = ', '): string =>
  arr && arr.length > 0 ? arr.join(sep) : '';
const num = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? n : null;
const text = (s: string | null | undefined): string => (s ?? '').trim();

// ─── Snoonu ─────────────────────────────────────────────────────────────────
// Snoonu (Qatar marketplace) — accepts CSV with both EN+AR columns. Image URL
// must be publicly accessible. Price in QAR (no currency symbol).

const SNOONU: PlatformTemplate = {
  id: 'snoonu',
  label: 'Snoonu',
  description: 'Qatar marketplace — bilingual columns, image URL must be public, price in QAR.',
  columns: [
    { header: 'SKU',                field: 'sku',             required: true,  value: (p) => p.master_sku },
    { header: 'Barcode',            field: 'barcode',         required: false, value: (p) => text(p.barcode) },
    { header: 'Product Name EN',    field: 'name_en',         required: true,  value: (p) => text(p.product_name_en), hint: 'English name is required for search.' },
    { header: 'Product Name AR',    field: 'name_ar',         required: true,  value: (p) => text(p.product_name_ar), hint: 'Arabic name is required for Qatari customers.' },
    { header: 'Brand',              field: 'brand',           required: true,  value: (p) => text(p.brand?.name) },
    { header: 'Main Category',      field: 'category',        required: true,  value: (p) => text(p.category?.name) },
    { header: 'Sub Category',       field: 'subcategory',     required: false, value: (p) => text(p.product_type) },
    { header: 'Size',               field: 'size',            required: false, value: (p) => text(p.size) },
    { header: 'Color',              field: 'color',           required: false, value: (p) => text(p.color) },
    { header: 'Price (QAR)',        field: 'price',           required: true,  value: (p) => num(p.price), hint: 'Price must be > 0 QAR.' },
    { header: 'Discount Price',     field: 'discount_price',  required: false, value: (p) => num(p.discount_price) },
    { header: 'Stock Quantity',     field: 'stock',           required: true,  value: (p) => num(p.stock_quantity), hint: 'Stock must be set (0 is OK).' },
    { header: 'Image URL',          field: 'image_url',       required: true,  value: (p) => text(p.image_url), hint: 'Public image URL required.' },
    { header: 'Description EN',     field: 'description_en',  required: true,  value: (p) => text(p.description_en) },
    { header: 'Description AR',     field: 'description_ar',  required: true,  value: (p) => text(p.description_ar) },
    { header: 'Usage EN',           field: 'usage_en',        required: false, value: (p) => text(p.usage_en) },
    { header: 'Usage AR',           field: 'usage_ar',        required: false, value: (p) => text(p.usage_ar) },
    { header: 'Keywords EN',        field: 'keywords_en',     required: false, value: (p) => join(p.keywords_en) },
    { header: 'Keywords AR',        field: 'keywords_ar',     required: false, value: (p) => join(p.keywords_ar, '، ') },
  ],
};

// ─── Talabat ────────────────────────────────────────────────────────────────
// Talabat — barcode required (per their merchant onboarding spec). Bilingual.
// Stock and price must be numeric.

const TALABAT: PlatformTemplate = {
  id: 'talabat',
  label: 'Talabat',
  description: 'Qatar food delivery — barcode required, strict numeric fields.',
  columns: [
    { header: 'SKU',                field: 'sku',             required: true,  value: (p) => p.master_sku },
    { header: 'Barcode',            field: 'barcode',         required: true,  value: (p) => text(p.barcode), hint: 'Talabat requires a barcode for inventory sync.' },
    { header: 'Name EN',            field: 'name_en',         required: true,  value: (p) => text(p.product_name_en) },
    { header: 'Name AR',            field: 'name_ar',         required: true,  value: (p) => text(p.product_name_ar) },
    { header: 'Brand',              field: 'brand',           required: true,  value: (p) => text(p.brand?.name) },
    { header: 'Category',           field: 'category',        required: true,  value: (p) => text(p.category?.name) },
    { header: 'Price (QAR)',        field: 'price',           required: true,  value: (p) => num(p.price), hint: 'Talabat requires price > 0.' },
    { header: 'Discount Price',     field: 'discount_price',  required: false, value: (p) => num(p.discount_price) },
    { header: 'Stock',              field: 'stock',           required: true,  value: (p) => num(p.stock_quantity) },
    { header: 'Image URL',          field: 'image_url',       required: true,  value: (p) => text(p.image_url) },
    { header: 'Description EN',     field: 'description_en',  required: true,  value: (p) => text(p.description_en) },
    { header: 'Description AR',     field: 'description_ar',  required: true,  value: (p) => text(p.description_ar) },
    { header: 'Size',               field: 'size',            required: false, value: (p) => text(p.size) },
  ],
};

// ─── Rafeeq ─────────────────────────────────────────────────────────────────
// Rafeeq (Qatar delivery) — Arabic-first marketplace. AR fields are strict.

const RAFEEQ: PlatformTemplate = {
  id: 'rafeeq',
  label: 'Rafeeq',
  description: 'Qatar delivery — Arabic-first, AR fields strictly required.',
  columns: [
    { header: 'الـ SKU',                  field: 'sku',             required: true,  value: (p) => p.master_sku },
    { header: 'الباركود',                  field: 'barcode',         required: false, value: (p) => text(p.barcode) },
    { header: 'اسم المنتج (عربي)',          field: 'name_ar',         required: true,  value: (p) => text(p.product_name_ar), hint: 'Rafeeq requires Arabic product name.' },
    { header: 'اسم المنتج (إنجليزي)',       field: 'name_en',         required: true,  value: (p) => text(p.product_name_en) },
    { header: 'العلامة التجارية',           field: 'brand',           required: true,  value: (p) => text(p.brand?.name_ar || p.brand?.name) },
    { header: 'الفئة',                    field: 'category',        required: true,  value: (p) => text(p.category?.name_ar || p.category?.name) },
    { header: 'السعر (ر.ق)',              field: 'price',           required: true,  value: (p) => num(p.price) },
    { header: 'سعر العرض',                field: 'discount_price',  required: false, value: (p) => num(p.discount_price) },
    { header: 'الكمية',                   field: 'stock',           required: true,  value: (p) => num(p.stock_quantity) },
    { header: 'رابط الصورة',               field: 'image_url',       required: true,  value: (p) => text(p.image_url) },
    { header: 'الوصف (عربي)',             field: 'description_ar',  required: true,  value: (p) => text(p.description_ar), hint: 'Rafeeq requires Arabic description.' },
    { header: 'الوصف (إنجليزي)',          field: 'description_en',  required: false, value: (p) => text(p.description_en) },
    { header: 'طريقة الاستخدام (عربي)',    field: 'usage_ar',        required: false, value: (p) => text(p.usage_ar) },
    { header: 'الكلمات المفتاحية (عربي)',  field: 'keywords_ar',     required: false, value: (p) => join(p.keywords_ar, '، ') },
  ],
};

// ─── Shopify (CSV format — for manual import via Shopify Admin) ─────────────
// Even with the Shopify API push path, having a CSV fallback is useful.
// Uses Shopify's official import column names.

const SHOPIFY: PlatformTemplate = {
  id: 'shopify',
  label: 'Shopify',
  description: 'Shopify CSV import — for manual upload via Products → Import.',
  columns: [
    { header: 'Handle',           field: 'handle',          required: true,  value: (p) => slugify(p.product_name_en ?? p.master_sku) },
    { header: 'Title',            field: 'name_en',         required: true,  value: (p) => text(p.product_name_en) },
    { header: 'Body (HTML)',      field: 'body_html',       required: false, value: (p) => text(p.description_en) },
    { header: 'Vendor',           field: 'brand',           required: true,  value: (p) => text(p.brand?.name) },
    { header: 'Type',             field: 'category',        required: false, value: (p) => text(p.category?.name) },
    { header: 'Tags',             field: 'tags',            required: false, value: (p) => join(p.keywords_en) },
    { header: 'Published',        field: 'published',       required: false, value: () => 'TRUE' },
    { header: 'Variant SKU',      field: 'sku',             required: true,  value: (p) => p.master_sku },
    { header: 'Variant Barcode',  field: 'barcode',         required: false, value: (p) => text(p.barcode) },
    { header: 'Variant Price',    field: 'price',           required: true,  value: (p) => num(p.price)?.toFixed(2) ?? null },
    { header: 'Variant Inventory Qty', field: 'stock',      required: true,  value: (p) => num(p.stock_quantity) },
    { header: 'Image Src',        field: 'image_url',       required: true,  value: (p) => text(p.image_url) },
  ],
};

// ─── Registry ───────────────────────────────────────────────────────────────

export const PLATFORMS: Record<ExportTarget, PlatformTemplate> = {
  snoonu: SNOONU,
  talabat: TALABAT,
  rafeeq: RAFEEQ,
  shopify: SHOPIFY,
};

export function getTemplate(target: ExportTarget): PlatformTemplate {
  const t = PLATFORMS[target];
  if (!t) throw new Error(`Unknown export target: ${target}`);
  return t;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

/**
 * Build a single row of data for a given platform template.
 * Returns array of cells in column order.
 */
export function buildRow(template: PlatformTemplate, p: SourceProduct): Array<string | number | null> {
  return template.columns.map((col) => col.value(p));
}

/**
 * Build the header row (CSV/XLSX first line).
 */
export function buildHeader(template: PlatformTemplate): string[] {
  return template.columns.map((col) => col.header);
}
