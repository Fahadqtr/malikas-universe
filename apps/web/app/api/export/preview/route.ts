/**
 * POST /api/export/preview
 *
 * Body:
 *   {
 *     target:     'snoonu' | 'talabat' | 'rafeeq' | 'shopify'  (required)
 *     master_skus?: string[]      (optional — if provided, only these are checked)
 *     filters?: {                  (optional — used when master_skus not provided)
 *       brand_id?:    number,
 *       category_id?: number,
 *       q?:           string,
 *     }
 *   }
 *
 * Behavior:
 *   • Loads candidate products from `products` where status='active' AND not deleted
 *   • Applies filters / specific SKUs
 *   • Runs validator for target platform
 *   • Returns { eligible_count, blocked_count, blocked: [{sku, reasons[]}], sample: [...] }
 *
 * The 'sample' is the first 10 eligible products — for UI preview only.
 * The full export happens via /api/export/generate.
 *
 * Hard rule: only 'active' (approved) products are ever considered.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { validateBatch } from '@/lib/export-validator';
import type { ExportTarget, SourceProduct } from '@/lib/export-templates';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  target: z.enum(['snoonu', 'talabat', 'rafeeq', 'shopify']),
  master_skus: z.array(z.string()).max(2000).optional(),
  filters: z
    .object({
      brand_id: z.number().int().optional(),
      category_id: z.number().int().optional(),
      q: z.string().trim().optional(),
    })
    .optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor', 'viewer'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot preview exports`, 403);
  }

  const body = Body.parse(await req.json());
  const admin = createAdminSupabaseClient();

  // ── Base query: only approved, non-deleted products ──────────────────────
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

  if (body.master_skus?.length) {
    query = query.in('master_sku', body.master_skus);
  }
  if (body.filters?.brand_id) query = query.eq('brand_id', body.filters.brand_id);
  if (body.filters?.category_id) query = query.eq('category_id', body.filters.category_id);
  if (body.filters?.q) {
    query = query.or(
      `product_name_en.ilike.%${body.filters.q}%,product_name_ar.ilike.%${body.filters.q}%,master_sku.ilike.%${body.filters.q}%`,
    );
  }
  query = query.order('updated_at', { ascending: false }).limit(2000);

  const { data, error } = await query;
  if (error) return err('LIST_FAILED', error.message, 500);

  const products = (data ?? []) as unknown as Array<SourceProduct & { product_status: string }>;

  // ── Validate ──────────────────────────────────────────────────────────────
  const outcome = validateBatch(products, body.target as ExportTarget);

  // Build a small sample so UI can show "what will be exported"
  const sample = outcome.eligible.slice(0, 10).map((p) => ({
    master_sku: p.master_sku,
    product_name_en: p.product_name_en,
    product_name_ar: p.product_name_ar,
    brand: p.brand?.name,
    category: p.category?.name,
    price: p.price,
    image_url: p.image_url,
  }));

  return ok({
    target: outcome.target,
    total: outcome.total,
    eligible_count: outcome.eligible_count,
    blocked_count: outcome.blocked_count,
    blocked: outcome.blocked,
    sample,
  });
});
