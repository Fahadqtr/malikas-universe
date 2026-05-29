/**
 * POST /api/snoonu-export/inspect
 *
 * Accept a Snoonu xlsx export (multipart/form-data, field name "file") and
 * return its structure WITHOUT modifying any database row.
 *
 * Returns:
 *   {
 *     sheet_name: string,
 *     row_count: number,
 *     column_count: number,
 *     headers: Array<{ index, name, classification, coverage_pct, filled }>,
 *     sample_rows: Array<Record<string, unknown>>,    // first 3 non-empty cells per row
 *     classification_summary: {
 *       has_spi: boolean,
 *       has_name_en: boolean,
 *       has_name_ar: boolean,
 *       has_per_branch_price: boolean,
 *       has_per_branch_stock: boolean,
 *       has_per_branch_availability: boolean,
 *       has_category: boolean,
 *       has_sku: boolean,
 *       has_barcode: boolean,
 *     }
 *   }
 *
 * READ-ONLY. Used by /snoonu-fast-sync to confirm columns before importing.
 */

import { NextRequest } from 'next/server';
import * as XLSX from 'xlsx';
import { ok, err, withErrorHandling } from '@/lib/api-response';

export const runtime = 'nodejs';
export const maxDuration = 60;

function classify(header: string): string {
  const h = String(header || '').toLowerCase();
  if (/spi|unique.?identifier/.test(h)) return 'ID_SPI';
  if (/name.*\(en\)|name en|product name \(en\)/.test(h)) return 'NAME_EN';
  if (/name.*\(ar\)|name ar|product name \(ar\)/.test(h)) return 'NAME_AR';
  if (/description.*\(en\)|description en/.test(h)) return 'DESC_EN';
  if (/description.*\(ar\)|description ar/.test(h)) return 'DESC_AR';
  if (/price.*ali bin abdullah/.test(h)) return 'PRICE_ALI';
  if (/price.*aziziyah/.test(h)) return 'PRICE_AZIZIYAH';
  if (/availability.*ali bin abdullah/.test(h)) return 'AVAIL_ALI';
  if (/availability.*aziziyah/.test(h)) return 'AVAIL_AZIZIYAH';
  if (/stock.*ali bin abdullah/.test(h)) return 'STOCK_ALI';
  if (/stock.*aziziyah/.test(h)) return 'STOCK_AZIZIYAH';
  if (/^stock$/.test(h)) return 'STOCK_TOTAL';
  if (/^sku\b|sku\(update\)/.test(h)) return 'SKU';
  if (/barcode/.test(h)) return 'BARCODE';
  if (/category|catalog|section/.test(h)) return 'CATEGORY';
  if (/image|photo|picture/.test(h)) return 'IMAGE';
  return 'OTHER';
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const form = await req.formData().catch(() => null);
  if (!form) return err('BAD_REQUEST', 'Expected multipart/form-data with file field', 400);

  const file = form.get('file');
  if (!(file instanceof Blob)) return err('NO_FILE', 'Missing file field', 400);

  const buf = Buffer.from(await file.arrayBuffer());
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer' });
  } catch (e) {
    return err('PARSE_FAILED', `Could not parse xlsx: ${(e as Error).message}`, 400);
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) return err('NO_SHEET', 'Workbook has no sheets', 400);

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: null,
    raw: true,
  });

  if (rows.length === 0) {
    return ok({
      sheet_name: sheetName,
      row_count: 0,
      column_count: 0,
      headers: [],
      sample_rows: [],
      classification_summary: emptyClassificationSummary(),
    });
  }

  const headers = Object.keys(rows[0]);

  // Coverage + classification per header
  const headerReport = headers.map((name, index) => {
    const classification = classify(name);
    const filled = rows.filter(
      (r) => r[name] !== null && r[name] !== undefined && String(r[name]).trim() !== '',
    ).length;
    return {
      index: index + 1,
      name,
      classification,
      filled,
      coverage_pct: Number(((filled / rows.length) * 100).toFixed(1)),
    };
  });

  const classifications = new Set(headerReport.map((h) => h.classification));
  const classification_summary = {
    has_spi: classifications.has('ID_SPI'),
    has_name_en: classifications.has('NAME_EN'),
    has_name_ar: classifications.has('NAME_AR'),
    has_desc_en: classifications.has('DESC_EN'),
    has_desc_ar: classifications.has('DESC_AR'),
    has_per_branch_price:
      classifications.has('PRICE_ALI') || classifications.has('PRICE_AZIZIYAH'),
    has_per_branch_stock:
      classifications.has('STOCK_ALI') || classifications.has('STOCK_AZIZIYAH'),
    has_per_branch_availability:
      classifications.has('AVAIL_ALI') || classifications.has('AVAIL_AZIZIYAH'),
    has_total_stock: classifications.has('STOCK_TOTAL'),
    has_category: classifications.has('CATEGORY'),
    has_sku: classifications.has('SKU'),
    has_barcode: classifications.has('BARCODE'),
    has_image: classifications.has('IMAGE'),
  };

  // First 3 rows, only non-null fields
  const sample_rows = rows.slice(0, 3).map((r) => {
    const out: Record<string, unknown> = {};
    for (const h of headers) {
      const v = r[h];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        out[h] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
      }
    }
    return out;
  });

  return ok({
    sheet_name: sheetName,
    row_count: rows.length,
    column_count: headers.length,
    headers: headerReport,
    sample_rows,
    classification_summary,
  });
});

function emptyClassificationSummary() {
  return {
    has_spi: false,
    has_name_en: false,
    has_name_ar: false,
    has_desc_en: false,
    has_desc_ar: false,
    has_per_branch_price: false,
    has_per_branch_stock: false,
    has_per_branch_availability: false,
    has_total_stock: false,
    has_category: false,
    has_sku: false,
    has_barcode: false,
    has_image: false,
  };
}
