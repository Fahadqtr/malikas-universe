/**
 * POST /api/export/generate
 *
 * Body:
 *   {
 *     target:      'snoonu' | 'talabat' | 'rafeeq' | 'shopify'   (required)
 *     format:      'csv' | 'xlsx'                                (required)
 *     master_skus?: string[]   (optional — explicit selection)
 *     filters?: { brand_id?, category_id?, q? }                  (optional)
 *     notes?:       string     (optional — saved to export_history)
 *   }
 *
 * Behavior:
 *   1. Load approved + non-deleted products (same filter logic as preview)
 *   2. Run validator — block products with missing required fields
 *   3. Generate file:
 *        CSV  — UTF-8 BOM + comma-separated, RFC-4180 quoting (handles Arabic)
 *        XLSX — via SheetJS (xlsx package, already in deps)
 *   4. Write export_history row
 *   5. Return file as download
 *
 * Returns:
 *   • on success: file body with Content-Disposition: attachment
 *   • on validation-only failure (all blocked): JSON error with reasons summary
 *
 * Hard rules:
 *   ✗ never export non-active products
 *   ✗ never export products with missing required fields (auto-skipped)
 *   ✓ Arabic text preserved via UTF-8 BOM (so Excel detects encoding)
 *   ✓ every export is logged to export_history
 */
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { validateBatch } from '@/lib/export-validator';
import {
  buildHeader,
  buildRow,
  getTemplate,
  type ExportTarget,
  type SourceProduct,
} from '@/lib/export-templates';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  target: z.enum(['snoonu', 'talabat', 'rafeeq', 'shopify']),
  format: z.enum(['csv', 'xlsx']),
  master_skus: z.array(z.string()).max(5000).optional(),
  filters: z
    .object({
      brand_id: z.number().int().optional(),
      category_id: z.number().int().optional(),
      q: z.string().trim().optional(),
    })
    .optional(),
  notes: z.string().max(500).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot generate exports`, 403);
  }

  const body = Body.parse(await req.json());
  const admin = createAdminSupabaseClient();

  // ── Load approved products ────────────────────────────────────────────────
  let query = admin
    .from('products')
    .select(
      `master_sku, barcode, product_name_en, product_name_ar,
       product_type, variant, color, size,
       price, discount_price, cost, stock_quantity, stock_status, product_status,
       description_en, description_ar, usage_en, usage_ar,
       keywords_en, keywords_ar, image_url,
       brand:brands(id, name, name_ar),
       category:categories(id, name, name_ar)`,
    )
    .eq('product_status', 'active')
    .is('deleted_at', null);

  if (body.master_skus?.length) query = query.in('master_sku', body.master_skus);
  if (body.filters?.brand_id) query = query.eq('brand_id', body.filters.brand_id);
  if (body.filters?.category_id) query = query.eq('category_id', body.filters.category_id);
  if (body.filters?.q) {
    query = query.or(
      `product_name_en.ilike.%${body.filters.q}%,product_name_ar.ilike.%${body.filters.q}%,master_sku.ilike.%${body.filters.q}%`,
    );
  }
  query = query.order('master_sku').limit(5000);

  const { data, error } = await query;
  if (error) return err('LIST_FAILED', error.message, 500);

  const products = (data ?? []) as unknown as Array<SourceProduct & { product_status: string }>;
  const outcome = validateBatch(products, body.target as ExportTarget);

  if (outcome.eligible_count === 0) {
    return err(
      'NOTHING_TO_EXPORT',
      `0 products passed validation for ${body.target}. ${outcome.blocked_count} blocked.`,
      400,
      { blocked: outcome.blocked.slice(0, 20) },
    );
  }

  // ── Build file ────────────────────────────────────────────────────────────
  const template = getTemplate(body.target as ExportTarget);
  const headers = buildHeader(template);
  const rows = outcome.eligible.map((p) => buildRow(template, p));

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `malikas-${body.target}-${stamp}.${body.format}`;

  let fileBytes: Buffer;
  let contentType: string;

  if (body.format === 'csv') {
    fileBytes = buildCsv(headers, rows);
    contentType = 'text/csv; charset=utf-8';
  } else {
    fileBytes = buildXlsx(headers, rows, template.label);
    contentType =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  // ── Record in export_history (non-fatal) ─────────────────────────────────
  void admin
    .from('export_history')
    .insert({
      target: body.target,
      format: body.format,
      filters: {
        master_skus_count: body.master_skus?.length ?? null,
        brand_id: body.filters?.brand_id ?? null,
        category_id: body.filters?.category_id ?? null,
        q: body.filters?.q ?? null,
      },
      product_count: outcome.eligible_count,
      blocked_count: outcome.blocked_count,
      file_bytes: fileBytes.length,
      filename,
      exported_by: actor.email,
      notes: body.notes ?? null,
    })
    .then(() => undefined);

  return new NextResponse(fileBytes as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Export-Eligible': String(outcome.eligible_count),
      'X-Export-Blocked': String(outcome.blocked_count),
    },
  });
});

// ─── CSV builder (RFC-4180 + UTF-8 BOM for Arabic in Excel) ──────────────────

function buildCsv(headers: string[], rows: Array<Array<string | number | null>>): Buffer {
  const lines: string[] = [];
  lines.push(headers.map(csvCell).join(','));
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  // UTF-8 BOM — required so Excel treats the file as UTF-8 and preserves Arabic
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n'), 'utf8')]);
}

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── XLSX builder (SheetJS) ──────────────────────────────────────────────────

function buildXlsx(
  headers: string[],
  rows: Array<Array<string | number | null>>,
  sheetName: string,
): Buffer {
  const wb = XLSX.utils.book_new();
  const aoa = [headers, ...rows.map((r) => r.map((v) => (v == null ? '' : v)))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Column widths: best-effort based on header length
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(12, Math.min(40, h.length + 6)) }));
  XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(sheetName));
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  return out;
}

function sanitizeSheetName(name: string): string {
  // Excel sheet names: ≤31 chars, no : \ / ? * [ ]
  return name.replace(/[:\\/?*\[\]]/g, '').slice(0, 31) || 'Sheet1';
}
