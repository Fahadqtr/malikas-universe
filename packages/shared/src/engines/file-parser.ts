/**
 * FILE PARSER — XLSX/CSV → row objects + platform detection.
 */
import type { FieldMapping } from './cleaning';

export type ParsedFile = {
  filename: string;
  format: 'xlsx' | 'xls' | 'csv';
  sheet_name?: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
  total_rows: number;
};

export type ParseOptions = {
  filename: string;
  sheet_name?: string;
  max_rows?: number;
};

export async function parseFile(
  buffer: ArrayBuffer | Uint8Array,
  options: ParseOptions,
): Promise<ParsedFile> {
  const ext = options.filename.toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'tsv') return parseCsv(buffer, options);
  if (ext === 'xlsx' || ext === 'xls') return parseExcel(buffer, options);
  throw new Error(`Unsupported file format: ${ext}`);
}

async function parseExcel(buffer: ArrayBuffer | Uint8Array, options: ParseOptions): Promise<ParsedFile> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = options.sheet_name ?? wb.SheetNames[0]!;
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
  const trimmed = options.max_rows ? rows.slice(0, options.max_rows) : rows;
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];

  return {
    filename: options.filename,
    format: options.filename.toLowerCase().endsWith('.xls') ? 'xls' : 'xlsx',
    sheet_name: sheetName,
    headers,
    rows: trimmed,
    total_rows: rows.length,
  };
}

async function parseCsv(buffer: ArrayBuffer | Uint8Array, options: ParseOptions): Promise<ParsedFile> {
  const Papa = await import('papaparse');
  const text = new TextDecoder('utf-8').decode(buffer);
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  const rows = result.data;
  const trimmed = options.max_rows ? rows.slice(0, options.max_rows) : rows;
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
  return { filename: options.filename, format: 'csv', headers, rows: trimmed, total_rows: rows.length };
}

export const PLATFORM_PRESETS: Record<string, FieldMapping & { _matchHeaders: string[] }> = {
  snoonu: {
    snoonu_sku: 'SKU', barcode: 'Barcode',
    product_name_en: 'Item Name English', product_name_ar: 'Item Name Arabic',
    brand: 'Brand', price: 'Price', stock: 'Stock Quantity',
    description_en: 'Description English', description_ar: 'Description Arabic',
    image_url: 'Image URL', category_hint: 'Category', size: 'Size',
    _matchHeaders: ['Item Name English', 'Item Name Arabic'],
  },
  shopify: {
    snoonu_sku: 'Variant SKU', barcode: 'Variant Barcode',
    product_name_en: 'Title', brand: 'Vendor',
    price: 'Variant Price', stock: 'Variant Inventory Qty',
    description_en: 'Body (HTML)', image_url: 'Image Src', category_hint: 'Product Category',
    _matchHeaders: ['Handle', 'Variant SKU', 'Vendor'],
  },
  talabat: {
    snoonu_sku: 'SKU', product_name_en: 'English Name', product_name_ar: 'Arabic Name',
    price: 'Price', stock: 'Quantity', image_url: 'Image', category_hint: 'Category Name',
    _matchHeaders: ['English Name', 'Category Name'],
  },
  rafeeq: {
    snoonu_sku: 'SKU', product_name_en: 'Name EN', product_name_ar: 'Name AR',
    price: 'Price', stock: 'Stock', image_url: 'Image', category_hint: 'Category',
    _matchHeaders: ['Name EN', 'Name AR'],
  },
};

export function detectPlatform(headers: string[]): { platform: string; mapping: FieldMapping } | null {
  const normalized = headers.map((h) => h.trim());
  let bestScore = 0;
  let bestPlatform: string | null = null;
  for (const [platform, preset] of Object.entries(PLATFORM_PRESETS)) {
    const hits = preset._matchHeaders.filter((h) => normalized.includes(h)).length;
    if (hits > bestScore) {
      bestScore = hits;
      bestPlatform = platform;
    }
  }
  if (!bestPlatform || bestScore === 0) return null;
  const { _matchHeaders, ...mapping } = PLATFORM_PRESETS[bestPlatform]!;
  return { platform: bestPlatform, mapping };
}
