/**
 * POST /api/snoonu-catalog-mapper/auto-map
 *
 * Run the export-column parser against every row in a Snoonu import that
 * doesn't have a catalog mapping yet. Reads from raw_payload and fills in
 * snoonu_catalog/category/etc. where possible.
 *
 * Body:
 *   { import_id: number, only_missing?: boolean }
 *
 * Returns:
 *   { scanned, mapped, still_missing }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import {
  extractFromSnoonuExportRow,
  inferFromProductSignals,
} from '@/lib/reconciliation/snoonu-catalog';

export const runtime = 'nodejs';
export const maxDuration = 180;

const Schema = z.object({
  import_id: z.number().int(),
  only_missing: z.boolean().optional(),
  use_inference_fallback: z.boolean().optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  let q = admin
    .from('platform_products')
    .select(
      `id, raw_payload, brand, name_en, name_ar, category_name, normalized_name,
       snoonu_category`,
    )
    .eq('platform', 'snoonu')
    .eq('import_id', body.import_id);

  if (body.only_missing ?? true) q = q.is('snoonu_category', null);

  const { data: rows, error: selErr } = await q;
  if (selErr) return err('SELECT_FAILED', selErr.message, 500);
  if (!rows || rows.length === 0) {
    return ok({ scanned: 0, mapped: 0, still_missing: 0 });
  }

  let mapped = 0;
  let stillMissing = 0;
  const now = new Date().toISOString();
  const useInference = body.use_inference_fallback ?? false;

  // Process in parallel batches of 50 — single-row updates so no transaction issues
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await Promise.all(
      chunk.map(async (r) => {
        const row = r as {
          id: number;
          raw_payload: Record<string, unknown> | null;
          brand: string | null;
          name_en: string | null;
          name_ar: string | null;
          category_name: string | null;
          normalized_name: string | null;
        };

        // Try export-column parser first
        let mapping = row.raw_payload
          ? extractFromSnoonuExportRow(row.raw_payload)
          : null;

        if (!mapping || (!mapping.snoonu_category && !mapping.snoonu_catalog)) {
          if (useInference) {
            mapping = inferFromProductSignals({
              brand: row.brand,
              product_name: row.name_en ?? row.name_ar ?? row.normalized_name,
              category_name: row.category_name,
            });
          }
        }

        if (mapping && (mapping.snoonu_category || mapping.snoonu_catalog)) {
          await admin
            .from('platform_products')
            .update({
              ...mapping,
              catalog_checked_at: now,
            })
            .eq('id', row.id);
          mapped++;
        } else {
          stillMissing++;
        }
      }),
    );
  }

  return ok({
    scanned: rows.length,
    mapped,
    still_missing: stillMissing,
  });
});
