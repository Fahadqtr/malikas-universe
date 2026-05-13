/**
 * Platform export generators.
 * Each platform has its own CSV column layout — we map our master schema
 * into each platform's expected shape.
 */

export type ExportRow = {
  master_sku: string;
  snoonu_sku: string | null;
  barcode: string | null;
  product_name_en: string;
  product_name_ar: string;
  brand_name: string;
  category_name: string;
  subcategory_name: string | null;
  product_type: string | null;
  size: string | null;
  price: number;
  discount_price: number | null;
  stock_quantity: number;
  stock_status: string;
  product_status: string;
  description_en: string | null;
  description_ar: string | null;
  usage_en: string | null;
  usage_ar: string | null;
  keywords_en: string[] | null;
  keywords_ar: string[] | null;
  image_url: string | null;
};

function csvEscape(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\r\n');
}

// ─── Snoonu ──────────────────────────────────────────────────────────────────
export function exportSnoonu(rows: ExportRow[]): string {
  const headers = [
    'SKU',
    'Barcode',
    'Item Name English',
    'Item Name Arabic',
    'Brand',
    'Category',
    'Price',
    'Stock Quantity',
    'Description English',
    'Description Arabic',
    'How To Use English',
    'How To Use Arabic',
    'Image URL',
  ];
  const data = rows.map((r) => ({
    SKU: r.snoonu_sku ?? r.master_sku,
    Barcode: r.barcode ?? '',
    'Item Name English': r.product_name_en,
    'Item Name Arabic': r.product_name_ar,
    Brand: r.brand_name,
    Category: r.category_name,
    Price: r.price.toFixed(2),
    'Stock Quantity': r.stock_quantity,
    'Description English': r.description_en ?? '',
    'Description Arabic': r.description_ar ?? '',
    'How To Use English': r.usage_en ?? '',
    'How To Use Arabic': r.usage_ar ?? '',
    'Image URL': r.image_url ?? '',
  }));
  return toCsv(headers, data);
}

// ─── Shopify ────────────────────────────────────────────────────────────────
// Shopify Products CSV format (simplified — full format has 40+ columns)
export function exportShopify(rows: ExportRow[]): string {
  const headers = [
    'Handle',
    'Title',
    'Body (HTML)',
    'Vendor',
    'Product Category',
    'Type',
    'Tags',
    'Published',
    'Variant SKU',
    'Variant Barcode',
    'Variant Price',
    'Variant Inventory Qty',
    'Variant Inventory Policy',
    'Variant Inventory Tracker',
    'Image Src',
    'Status',
  ];
  const data = rows.map((r) => {
    // Build a rich HTML body combining description + usage
    const bodyParts: string[] = [];
    if (r.description_en) bodyParts.push(`<p>${escapeHtml(r.description_en)}</p>`);
    if (r.usage_en) bodyParts.push(`<h3>How to use</h3><p>${escapeHtml(r.usage_en).replace(/\n/g, '<br>')}</p>`);
    const body = bodyParts.join('');

    return {
      Handle: r.master_sku.toLowerCase(),
      Title: r.product_name_en,
      'Body (HTML)': body,
      Vendor: r.brand_name,
      'Product Category': r.category_name,
      Type: r.product_type ?? r.subcategory_name ?? '',
      Tags: [r.subcategory_name, ...(r.keywords_en ?? [])].filter(Boolean).join(', '),
      Published: r.product_status === 'active' ? 'TRUE' : 'FALSE',
      'Variant SKU': r.master_sku,
      'Variant Barcode': r.barcode ?? '',
      'Variant Price': r.price.toFixed(2),
      'Variant Inventory Qty': r.stock_quantity,
      'Variant Inventory Policy': 'deny',
      'Variant Inventory Tracker': 'shopify',
      'Image Src': r.image_url ?? '',
      Status: r.product_status === 'active' ? 'active' : 'draft',
    };
  });
  return toCsv(headers, data);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Talabat ────────────────────────────────────────────────────────────────
export function exportTalabat(rows: ExportRow[]): string {
  const headers = [
    'SKU',
    'English Name',
    'Arabic Name',
    'Category Name',
    'Price',
    'Quantity',
    'Image',
    'Description English',
    'Description Arabic',
    'How To Use English',
    'How To Use Arabic',
    'Barcode',
  ];
  const data = rows.map((r) => ({
    SKU: r.master_sku,
    'English Name': r.product_name_en,
    'Arabic Name': r.product_name_ar,
    'Category Name': r.category_name,
    Price: r.price.toFixed(2),
    Quantity: r.stock_quantity,
    Image: r.image_url ?? '',
    'Description English': r.description_en ?? '',
    'Description Arabic': r.description_ar ?? '',
    'How To Use English': r.usage_en ?? '',
    'How To Use Arabic': r.usage_ar ?? '',
    Barcode: r.barcode ?? '',
  }));
  return toCsv(headers, data);
}

// ─── Rafeeq ─────────────────────────────────────────────────────────────────
export function exportRafeeq(rows: ExportRow[]): string {
  const headers = [
    'SKU',
    'Name EN',
    'Name AR',
    'Category',
    'Brand',
    'Price',
    'Stock',
    'Image',
    'Barcode',
    'Description EN',
    'Description AR',
    'Usage EN',
    'Usage AR',
  ];
  const data = rows.map((r) => ({
    SKU: r.master_sku,
    'Name EN': r.product_name_en,
    'Name AR': r.product_name_ar,
    Category: r.category_name,
    Brand: r.brand_name,
    Price: r.price.toFixed(2),
    Stock: r.stock_quantity,
    Image: r.image_url ?? '',
    Barcode: r.barcode ?? '',
    'Description EN': r.description_en ?? '',
    'Description AR': r.description_ar ?? '',
    'Usage EN': r.usage_en ?? '',
    'Usage AR': r.usage_ar ?? '',
  }));
  return toCsv(headers, data);
}

// ─── Master ─────────────────────────────────────────────────────────────────
export function exportMaster(rows: ExportRow[]): string {
  const headers = [
    'master_sku',
    'snoonu_sku',
    'barcode',
    'product_name_en',
    'product_name_ar',
    'brand',
    'category',
    'subcategory',
    'product_type',
    'size',
    'price',
    'discount_price',
    'stock_quantity',
    'stock_status',
    'product_status',
    'description_en',
    'description_ar',
    'usage_en',
    'usage_ar',
    'keywords_en',
    'keywords_ar',
    'image_url',
  ];
  const data = rows.map((r) => ({
    master_sku: r.master_sku,
    snoonu_sku: r.snoonu_sku ?? '',
    barcode: r.barcode ?? '',
    product_name_en: r.product_name_en,
    product_name_ar: r.product_name_ar,
    brand: r.brand_name,
    category: r.category_name,
    subcategory: r.subcategory_name ?? '',
    product_type: r.product_type ?? '',
    size: r.size ?? '',
    price: r.price.toFixed(2),
    discount_price: r.discount_price?.toFixed(2) ?? '',
    stock_quantity: r.stock_quantity,
    stock_status: r.stock_status,
    product_status: r.product_status,
    description_en: r.description_en ?? '',
    description_ar: r.description_ar ?? '',
    usage_en: r.usage_en ?? '',
    usage_ar: r.usage_ar ?? '',
    keywords_en: (r.keywords_en ?? []).join(', '),
    keywords_ar: (r.keywords_ar ?? []).join('، '),
    image_url: r.image_url ?? '',
  }));
  return toCsv(headers, data);
}

export const EXPORTERS = {
  snoonu: exportSnoonu,
  shopify: exportShopify,
  talabat: exportTalabat,
  rafeeq: exportRafeeq,
  master: exportMaster,
} as const;

export type PlatformExport = keyof typeof EXPORTERS;
