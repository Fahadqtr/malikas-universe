/**
 * POST /api/reconciliation/imports/[id]/set-category
 *
 * Two bulk modes:
 *
 *   { row_ids: number[], category_name: string, subcategory_name?: string }
 *     → Manually apply a category to selected rows.
 *       category_source = 'manual', confidence = 1.00, category_missing = false
 *
 *   { auto_infer_missing: true }
 *     → Re-run the rule-based extractor on every row in this import that's
 *       still category_missing. Updates only the ones that get a hit.
 *
 *   { reextract_all: true }
 *     → Nuclear option: re-run the extractor on every row in this import.
 *       Useful after editing brand maps or rules in code.
 *
 * Returns: { updated: number, still_missing: number }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import { extractCategory } from '@/lib/reconciliation/category-extractor';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Schema = z.union([
  z.object({
    row_ids: z.array(z.number().int()).min(1).max(10000),
    category_name: z.string().min(1),
    subcategory_name: z.string().optional().nullable(),
  }),
  z.object({
    auto_infer_missing: z.literal(true),
  }),
  z.object({
    reextract_all: z.literal(true),
  }),
]);

type RouteContext = { params: { id: string } };

export const POST = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const importId = Number(params.id);
  if (!Number.isInteger(importId) || importId <= 0) {
    return err('BAD_ID', 'Invalid import id', 400);
  }

  const body = Schema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // ─── Manual bulk apply ────────────────────────────────────────────────────
  if ('row_ids' in body) {
    const { error: updErr, count } = await admin
      .from('platform_products')
      .update(
        {
          category_name: body.category_name,
          subcategory_name: body.subcategory_name ?? null,
          category_source: 'manual',
          category_confidence: 1.0,
          category_missing: false,
        },
        { count: 'exact' },
      )
      .eq('import_id', importId)
      .in('id', body.row_ids);

    if (updErr) return err('UPDATE_FAILED', updErr.message, 500);
    return ok({ updated: count ?? body.row_ids.length, still_missing: 0 });
  }

  // ─── Auto-infer (only missing) OR full re-extract ─────────────────────────
  const onlyMissing = 'auto_infer_missing' in body;

  let q = admin
    .from('platform_products')
    .select(
      `id, raw_category, raw_subcategory, name_en, name_ar, brand,
       product_type, description_en, description_ar`,
    )
    .eq('import_id', importId);
  if (onlyMissing) q = q.eq('category_missing', true);

  const { data: rows, error: selErr } = await q;
  if (selErr) return err('SELECT_FAILED', selErr.message, 500);
  if (!rows || rows.length === 0) {
    return ok({ updated: 0, still_missing: 0 });
  }

  let updated = 0;
  let stillMissing = 0;

  // Update in batches of 100 — Supabase API doesn't support a single UPDATE
  // … FROM VALUES across many rows, so we do it row-by-row but parallelize.
  await Promise.all(
    rows.map(async (r) => {
      const row = r as {
        id: number;
        raw_category: string | null;
        raw_subcategory: string | null;
        name_en: string | null;
        name_ar: string | null;
        brand: string | null;
        product_type: string | null;
        description_en: string | null;
        description_ar: string | null;
      };

      const cat = extractCategory({
        platform: 'snoonu',
        raw_category: row.raw_category,
        raw_subcategory: row.raw_subcategory,
        product_name: row.name_en ?? row.name_ar,
        product_type: row.product_type,
        brand: row.brand,
        description: row.description_en ?? row.description_ar,
      });

      if (cat.category_missing) {
        stillMissing++;
        if (onlyMissing) return; // leave row as-is
      } else {
        updated++;
      }

      await admin
        .from('platform_products')
        .update({
          category_name: cat.category_name,
          subcategory_name: cat.subcategory_name,
          category_confidence: cat.category_confidence,
          category_source: cat.category_source,
          category_missing: cat.category_missing,
        })
        .eq('id', row.id);
    }),
  );

  return ok({ updated, still_missing: stillMissing, scanned: rows.length });
});
