/**
 * Snoonu xlsx Fast Sync — importer library.
 *
 * Phase 13F.3. Parses the Snoonu Seller Portal xlsx export and turns each row
 * into a normalized `SnoonuExportRow`. Caller (the API endpoint) is responsible
 * for upserting into platform_products.
 *
 * Confirmed by the 13F.1 inspector against snoonu1.xlsx (1144 rows × 21 cols):
 *   - SPI(UniqueIdentifier)                            → snoonu_spi / source_product_id   [100% coverage]
 *   - Product Name (En)(Update)                        → name_en                            [100%]
 *   - Product Name (Ar)(Update)                        → name_ar                            [100%]
 *   - Product Description (En)(Update)                 → description_en                     [100%]
 *   - Product Description (Ar)(Update)                 → description_ar                     [100%]
 *   - Price For Branch …Ali Bin Abdullah Street…       → price_ali                          [100%]
 *   - Price For Branch …Al Aziziyah…                   → price_aziziyah                     [100%]
 *   - Stock for …Ali Bin Abdullah Street…              → stock_ali                          [100%]
 *   - Stock for …Al Aziziyah…                          → stock_aziziyah                     [100%]
 *   - Availability for …Ali Bin Abdullah Street…       → available_ali                      [100%]
 *   - Availability for …Al Aziziyah…                   → available_aziziyah                 [100%]
 *
 * Missing from the export and therefore NOT populated by this importer:
 *   image, SKU, barcode, catalog/category. Those still come from
 *   - the catalog-section scraper (Phase 13F.5)
 *   - the browser audit pipeline (Phase 13E)
 */

import * as XLSX from 'xlsx';
import { normalizeProductName } from './text-normalizer';

// ─── Branch identifiers (constants — matched against export headers loosely) ─

export const BRANCH_ALI = 'Ali Bin Abdullah Street';
export const BRANCH_AZIZIYAH = 'Al Aziziyah Building 13, first floor, Apartment 3';

// ─── Types ─────────────────────────────────────────────────────────────────

export type SnoonuExportRow = {
  /** 1-based row index in the source xlsx (header row is row 1, first data row is 2) */
  row_index: number;

  // Identity
  spi: string | null;
  name_en: string | null;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;

  // Per-branch price
  price_ali: number | null;
  price_aziziyah: number | null;

  // Per-branch stock
  stock_ali: number | null;
  stock_aziziyah: number | null;

  // Per-branch availability
  available_ali: boolean | null;
  available_aziziyah: boolean | null;

  // Derived fields ready to apply to platform_products
  derived: {
    /** Default price = Ali Bin Abdullah branch price, falls back to Aziziyah */
    price: number | null;
    /** Total stock = sum of both branches (nulls treated as 0) */
    stock_quantity: number;
    /** active if any branch available */
    platform_status: 'active' | 'out_of_stock';
    /** Branches array ready for platform_products.snoonu_branches JSONB */
    snoonu_branches: Array<{
      name: string;
      price: number | null;
      stock: number;
      available: boolean;
    }>;
    /** Normalized name for fallback matching when SPI doesn't exist yet */
    normalized_name: string | null;
  };
};

export type ParsedExport = {
  source_filename: string;
  sheet_name: string;
  total_rows: number;
  rows: SnoonuExportRow[];
  warnings: string[];
};

// ─── Column resolution ─────────────────────────────────────────────────────

/**
 * Resolve actual header names by fuzzy classification. The seller portal
 * occasionally tweaks header capitalization or appends/removes "(Update)" —
 * matching by lowercased substring keeps the importer resilient.
 */
function resolveColumns(headers: string[]): {
  spi?: string;
  name_en?: string;
  name_ar?: string;
  desc_en?: string;
  desc_ar?: string;
  price_ali?: string;
  price_aziziyah?: string;
  stock_ali?: string;
  stock_aziziyah?: string;
  avail_ali?: string;
  avail_aziziyah?: string;
} {
  const out: Record<string, string> = {};
  for (const raw of headers) {
    const h = raw.toLowerCase();
    if (!out.spi && /spi|unique.?identifier/.test(h)) out.spi = raw;
    else if (!out.name_en && /product name.*\(en\)|name.*\(en\)/.test(h)) out.name_en = raw;
    else if (!out.name_ar && /product name.*\(ar\)|name.*\(ar\)/.test(h)) out.name_ar = raw;
    else if (!out.desc_en && /description.*\(en\)/.test(h)) out.desc_en = raw;
    else if (!out.desc_ar && /description.*\(ar\)/.test(h)) out.desc_ar = raw;
    else if (!out.price_ali && /price.*ali bin abdullah/.test(h)) out.price_ali = raw;
    else if (!out.price_aziziyah && /price.*aziziyah/.test(h)) out.price_aziziyah = raw;
    else if (!out.stock_ali && /stock.*ali bin abdullah/.test(h)) out.stock_ali = raw;
    else if (!out.stock_aziziyah && /stock.*aziziyah/.test(h)) out.stock_aziziyah = raw;
    else if (!out.avail_ali && /availability.*ali bin abdullah/.test(h)) out.avail_ali = raw;
    else if (!out.avail_aziziyah && /availability.*aziziyah/.test(h)) out.avail_aziziyah = raw;
  }
  return out;
}

// ─── Cell coercion helpers ─────────────────────────────────────────────────

function toString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toInt(v: unknown): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.round(n);
}

/**
 * Snoonu uses several encodings for availability:
 *   - boolean true / false
 *   - "TRUE" / "FALSE"
 *   - "Available" / "Not Available"
 *   - 1 / 0
 *   - "yes" / "no"
 * Everything ambiguous returns null so the importer can default safely.
 */
function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (['true', 'yes', 'y', '1', 'available', 'in stock', 'in_stock'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'not available', 'unavailable', 'out of stock', 'out_of_stock'].includes(s)) return false;
  return null;
}

// ─── Public API ────────────────────────────────────────────────────────────

export function parseSnoonuExportBuffer(
  buf: Buffer,
  source_filename: string,
): ParsedExport {
  const warnings: string[] = [];

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    throw new Error(`Failed to parse xlsx: ${(e as Error).message}`);
  }

  const sheet_name = wb.SheetNames[0];
  if (!sheet_name) throw new Error('Workbook has no sheets');

  const ws = wb.Sheets[sheet_name];
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: null,
    raw: true,
  });

  if (records.length === 0) {
    return {
      source_filename,
      sheet_name,
      total_rows: 0,
      rows: [],
      warnings: ['Sheet contains no data rows'],
    };
  }

  const headers = Object.keys(records[0]);
  const cols = resolveColumns(headers);

  // Surface missing-column warnings up front so the API caller can show them.
  const required = ['spi', 'name_en'];
  for (const k of required) {
    if (!cols[k as keyof typeof cols]) {
      warnings.push(`Required column not found: ${k}`);
    }
  }
  const optionalButExpected = [
    'name_ar', 'desc_en', 'desc_ar',
    'price_ali', 'price_aziziyah',
    'stock_ali', 'stock_aziziyah',
    'avail_ali', 'avail_aziziyah',
  ];
  for (const k of optionalButExpected) {
    if (!cols[k as keyof typeof cols]) {
      warnings.push(`Expected column missing (will be left null): ${k}`);
    }
  }

  const rows: SnoonuExportRow[] = records.map((rec, idx) => {
    const spi = cols.spi ? toString(rec[cols.spi]) : null;
    const name_en = cols.name_en ? toString(rec[cols.name_en]) : null;
    const name_ar = cols.name_ar ? toString(rec[cols.name_ar]) : null;
    const description_en = cols.desc_en ? toString(rec[cols.desc_en]) : null;
    const description_ar = cols.desc_ar ? toString(rec[cols.desc_ar]) : null;

    const price_ali = cols.price_ali ? toNumber(rec[cols.price_ali]) : null;
    const price_aziziyah = cols.price_aziziyah ? toNumber(rec[cols.price_aziziyah]) : null;
    const stock_ali = cols.stock_ali ? toInt(rec[cols.stock_ali]) : null;
    const stock_aziziyah = cols.stock_aziziyah ? toInt(rec[cols.stock_aziziyah]) : null;
    const available_ali = cols.avail_ali ? toBool(rec[cols.avail_ali]) : null;
    const available_aziziyah = cols.avail_aziziyah ? toBool(rec[cols.avail_aziziyah]) : null;

    // ─── Derived fields ─────────────────────────────────────────────────
    const price = price_ali ?? price_aziziyah ?? null;
    const stock_quantity = (stock_ali ?? 0) + (stock_aziziyah ?? 0);
    const anyAvailable = available_ali === true || available_aziziyah === true;
    const platform_status: 'active' | 'out_of_stock' = anyAvailable ? 'active' : 'out_of_stock';

    const snoonu_branches = [
      {
        name: BRANCH_ALI,
        price: price_ali ?? null,
        stock: stock_ali ?? 0,
        available: available_ali === true,
      },
      {
        name: BRANCH_AZIZIYAH,
        price: price_aziziyah ?? null,
        stock: stock_aziziyah ?? 0,
        available: available_aziziyah === true,
      },
    ];

    const normalized_name = name_en
      ? normalizeProductName(name_en).normalized_name
      : null;

    return {
      row_index: idx + 2, // +1 for 0→1 conversion, +1 because header is row 1
      spi,
      name_en,
      name_ar,
      description_en,
      description_ar,
      price_ali,
      price_aziziyah,
      stock_ali,
      stock_aziziyah,
      available_ali,
      available_aziziyah,
      derived: {
        price,
        stock_quantity,
        platform_status,
        snoonu_branches,
        normalized_name,
      },
    };
  });

  return {
    source_filename,
    sheet_name,
    total_rows: rows.length,
    rows,
    warnings,
  };
}

// ─── Summary helpers for the API response ──────────────────────────────────

export type ImportSummary = {
  total_rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  missing_spi: number;
  missing_name: number;
  prices_captured: number;
  stocks_captured: number;
  availability_captured: number;
  branch_data_coverage_pct: number; // %
  warnings: string[];
};

export function emptySummary(total_rows: number, warnings: string[]): ImportSummary {
  return {
    total_rows,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    missing_spi: 0,
    missing_name: 0,
    prices_captured: 0,
    stocks_captured: 0,
    availability_captured: 0,
    branch_data_coverage_pct: 0,
    warnings,
  };
}

/**
 * Validates a row before upsert. Returns null if the row is acceptable,
 * else the reason it should be skipped.
 */
export function validateRow(row: SnoonuExportRow): string | null {
  if (!row.spi) return 'missing_spi';
  if (!row.name_en) return 'missing_name';
  return null;
}
