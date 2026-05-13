/**
 * GET /api/bulk-ai/drafts
 *
 * Lists AI-generated draft products with full review context.
 *
 * Query params:
 *   status       ready | needs_review | failed | approved | all  (default: all)
 *   q            free-text search across name_en/name_ar/sku
 *   brand_id     filter by brand
 *   category_id  filter by category
 *   sort         confidence_asc | confidence_desc | created_desc | created_asc (default: confidence_asc — lowest confidence first = needs review most)
 *   page, page_size
 *
 * Status mapping:
 *   ready         → product_status='draft'  AND ai_confidence >= 0.90
 *   needs_review  → product_status='draft'  AND ai_confidence <  0.90
 *   failed        → product_status='draft'  AND ai_meta->>'error_code' IS NOT NULL  (set on retry failure)
 *   approved      → product_status='active'
 *
 * Returns:
 *   {
 *     items: DraftItem[],
 *     total, page, page_size,
 *     status_counts: { ready, needs_review, failed, approved }
 *   }
 *
 * Each item is enriched with:
 *   - duplicate hints (other products with same name_en or brand+size)
 *   - primary image URL
 *   - brand + category names
 *   - marketplace_ready boolean (price>0, stock_quantity>0, names+description filled, image set)
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { checkReadiness } from '@/lib/readiness';

export const runtime = 'nodejs';

const Query = z.object({
  status: z.enum(['ready', 'needs_review', 'failed', 'approved', 'all']).default('all'),
  q: z.string().trim().optional(),
  brand_id: z.coerce.number().int().optional(),
  category_id: z.coerce.number().int().optional(),
  sort: z
    .enum(['confidence_asc', 'confidence_desc', 'created_desc', 'created_asc'])
    .default('confidence_asc'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(60),
});

const READY_THRESHOLD = 0.9;

export const GET = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor', 'viewer'].includes(actor.role)) {
    throw new Error('FORBIDDEN');
  }

  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = Query.parse(params);
  const admin = createAdminSupabaseClient();

  // ── Build base query ─────────────────────────────────────────────────────
  let query = admin
    .from('products')
    .select(
      `id, master_sku, product_name_en, product_name_ar, brand_id, category_id,
       subcategory_id, product_type, color, size,
       price, stock_quantity, stock_status, product_status,
       description_en, description_ar, keywords_en, keywords_ar,
       image_url, image_filename,
       ai_generated, ai_confidence, ai_meta,
       created_at, updated_at,
       brand:brands(id, name, name_ar, code),
       category:categories(id, name, name_ar, code)`,
      { count: 'exact' },
    )
    .eq('ai_generated', true)
    .is('deleted_at', null);

  // ── Status filters ───────────────────────────────────────────────────────
  if (q.status === 'ready') {
    query = query.eq('product_status', 'draft').gte('ai_confidence', READY_THRESHOLD);
  } else if (q.status === 'needs_review') {
    query = query.eq('product_status', 'draft').lt('ai_confidence', READY_THRESHOLD);
  } else if (q.status === 'failed') {
    // Failed = draft + ai_meta.error_code present
    query = query.eq('product_status', 'draft').not('ai_meta->>error_code', 'is', null);
  } else if (q.status === 'approved') {
    query = query.eq('product_status', 'active');
  }

  if (q.brand_id) query = query.eq('brand_id', q.brand_id);
  if (q.category_id) query = query.eq('category_id', q.category_id);

  if (q.q) {
    query = query.or(
      `product_name_en.ilike.%${q.q}%,product_name_ar.ilike.%${q.q}%,master_sku.ilike.%${q.q}%`,
    );
  }

  // ── Sort ─────────────────────────────────────────────────────────────────
  const sortMap: Record<typeof q.sort, [string, boolean]> = {
    confidence_asc: ['ai_confidence', true],
    confidence_desc: ['ai_confidence', false],
    created_asc: ['created_at', true],
    created_desc: ['created_at', false],
  };
  const [col, asc] = sortMap[q.sort];
  query = query.order(col, { ascending: asc, nullsFirst: false });

  // ── Pagination ───────────────────────────────────────────────────────────
  const from = (q.page - 1) * q.page_size;
  const to = from + q.page_size - 1;
  query = query.range(from, to);

  const { data: items, count, error } = await query;
  if (error) throw new Error(`LIST_FAILED: ${error.message}`);

  // ── Status counts (one query each, no joins) ─────────────────────────────
  const [
    { count: readyCount },
    { count: needsCount },
    { count: failedCount },
    { count: approvedCount },
  ] = await Promise.all([
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .eq('product_status', 'draft')
      .gte('ai_confidence', READY_THRESHOLD)
      .is('deleted_at', null),
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .eq('product_status', 'draft')
      .lt('ai_confidence', READY_THRESHOLD)
      .is('deleted_at', null),
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .eq('product_status', 'draft')
      .not('ai_meta->>error_code', 'is', null)
      .is('deleted_at', null),
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .eq('product_status', 'active')
      .is('deleted_at', null),
  ]);

  // ── Duplicate hints — per-page only, lightweight check ───────────────────
  // For every item, find other products with same name_en (case-insensitive)
  // OR same (brand_id, size) — these are the most common AI dupes.
  const enriched = await Promise.all(
    (items ?? []).map(async (item: Record<string, unknown>) => {
      const dupes = await findDuplicates(admin, item);
      const marketplaceReady = isMarketplaceReady(item);
      const aiCost = readNumber((item.ai_meta as Record<string, unknown>)?.cost_usd) ?? 0;
      // Cheap, pure — runs in-process. Shopify is the default target for the
      // grid badge; the editor side panel can request other targets on demand.
      const readiness = checkReadiness(item, 'shopify');
      return {
        ...item,
        _duplicates: dupes,
        _marketplace_ready: marketplaceReady,
        _ai_cost_usd: aiCost,
        _ui_status: deriveStatus(item),
        _readiness: {
          score: readiness.score,
          ready: readiness.ready,
          error_count: readiness.error_count,
          warning_count: readiness.warning_count,
        },
      };
    }),
  );

  return ok({
    items: enriched,
    total: count ?? 0,
    page: q.page,
    page_size: q.page_size,
    has_more: (count ?? 0) > q.page * q.page_size,
    status_counts: {
      ready: readyCount ?? 0,
      needs_review: needsCount ?? 0,
      failed: failedCount ?? 0,
      approved: approvedCount ?? 0,
    },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isMarketplaceReady(p: Record<string, unknown>): boolean {
  return Boolean(
    p.product_name_en &&
      p.product_name_ar &&
      p.description_en &&
      p.description_ar &&
      p.image_url &&
      typeof p.price === 'number' &&
      (p.price as number) > 0 &&
      typeof p.stock_quantity === 'number' &&
      (p.stock_quantity as number) > 0,
  );
}

function deriveStatus(p: Record<string, unknown>): 'ready' | 'needs_review' | 'failed' | 'approved' {
  if (p.product_status === 'active') return 'approved';
  const errCode = (p.ai_meta as Record<string, unknown>)?.error_code;
  if (errCode) return 'failed';
  const conf = (p.ai_confidence as number) ?? 0;
  return conf >= READY_THRESHOLD ? 'ready' : 'needs_review';
}

/**
 * Quick duplicate detection.
 * Returns minimal info — full check should run on Approve, not list.
 */
async function findDuplicates(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  item: Record<string, unknown>,
): Promise<Array<{ master_sku: string; product_name_en: string; reason: string }>> {
  const dupes: Array<{ master_sku: string; product_name_en: string; reason: string }> = [];
  const name = (item.product_name_en as string | null)?.trim();
  const brand_id = item.brand_id as number | null;
  const size = (item.size as string | null)?.trim();
  const my_sku = item.master_sku as string;

  // Same EN name (exact, case-insensitive)
  if (name) {
    const { data } = await admin
      .from('products')
      .select('master_sku, product_name_en')
      .ilike('product_name_en', name)
      .neq('master_sku', my_sku)
      .is('deleted_at', null)
      .limit(3);
    for (const d of data ?? []) {
      dupes.push({
        master_sku: d.master_sku,
        product_name_en: d.product_name_en,
        reason: 'same_name',
      });
    }
  }

  // Same brand + size
  if (brand_id && size && dupes.length < 3) {
    const { data } = await admin
      .from('products')
      .select('master_sku, product_name_en')
      .eq('brand_id', brand_id)
      .eq('size', size)
      .neq('master_sku', my_sku)
      .is('deleted_at', null)
      .limit(3);
    for (const d of data ?? []) {
      if (!dupes.find((x) => x.master_sku === d.master_sku)) {
        dupes.push({
          master_sku: d.master_sku,
          product_name_en: d.product_name_en,
          reason: 'same_brand_size',
        });
      }
    }
  }

  return dupes.slice(0, 3);
}
