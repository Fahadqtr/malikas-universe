/**
 * POST /api/bulk-ai/drafts/bulk-action
 *
 * Body:
 *   {
 *     action: 'approve' | 'reject' | 'retry' | 'export',
 *     master_skus: string[]   (max 200 per call)
 *   }
 *
 * Actions:
 *   approve  → product_status: 'active'  (uses ProductsService.transitionStatus which
 *              respects critical-issue blocking)
 *   reject   → product_status: 'archived' (NOT soft-deleted — stays visible in archive)
 *   retry    → resets ai_meta.error_code so the row appears under 'needs_review' again
 *              and bumps updated_at to push it up the queue
 *   export   → returns CSV (text/csv) of the selected drafts, marketplace-ready format
 *
 * Returns (non-export):
 *   { processed, succeeded[], failed: { master_sku, error }[] }
 *
 * Returns (export):
 *   CSV file as response body
 */
import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  action: z.enum(['approve', 'reject', 'retry', 'export']),
  master_skus: z.array(z.string().min(1)).min(1).max(200),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot perform bulk actions`, 403);
  }

  const body = Body.parse(await req.json());

  if (body.action === 'export') {
    return exportCsv(body.master_skus);
  }

  const { products } = getServices(actor);
  const admin = createAdminSupabaseClient();

  const succeeded: string[] = [];
  const failed: Array<{ master_sku: string; error: string }> = [];

  for (const sku of body.master_skus) {
    try {
      if (body.action === 'approve') {
        await products.transitionStatus(sku, 'active');
        succeeded.push(sku);
      } else if (body.action === 'reject') {
        await products.transitionStatus(sku, 'archived');
        succeeded.push(sku);
      } else if (body.action === 'retry') {
        // Reset error flag in ai_meta, bump updated_at — pulls back to "needs_review" lane
        const { data: cur } = await admin
          .from('products')
          .select('ai_meta')
          .eq('master_sku', sku)
          .single();
        const cleanMeta = { ...(cur?.ai_meta as Record<string, unknown> | null ?? {}) };
        delete cleanMeta.error_code;
        delete cleanMeta.error_message;
        const { error } = await admin
          .from('products')
          .update({ ai_meta: cleanMeta, updated_by: actor.email })
          .eq('master_sku', sku);
        if (error) throw new Error(error.message);
        succeeded.push(sku);
      }
    } catch (e) {
      failed.push({ master_sku: sku, error: e instanceof Error ? e.message : 'unknown' });
    }
  }

  return ok({
    action: body.action,
    processed: body.master_skus.length,
    succeeded,
    failed,
  });
});

// ─── CSV export ──────────────────────────────────────────────────────────────

async function exportCsv(master_skus: string[]): Promise<NextResponse> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('products')
    .select(
      `master_sku, product_name_en, product_name_ar, product_type, variant, color, size,
       price, discount_price, stock_quantity, stock_status, product_status,
       description_en, description_ar, usage_en, usage_ar,
       keywords_en, keywords_ar, image_url, ai_confidence,
       brand:brands(name), category:categories(name)`,
    )
    .in('master_sku', master_skus);

  if (error) {
    return NextResponse.json(
      { ok: false, error: { code: 'EXPORT_FAILED', message: error.message } },
      { status: 500 },
    );
  }

  const rows = data ?? [];
  const headers = [
    'master_sku',
    'product_name_en',
    'product_name_ar',
    'brand',
    'category',
    'product_type',
    'variant',
    'color',
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
    'ai_confidence',
  ];

  const lines = [headers.join(',')];
  for (const r of rows as Array<Record<string, unknown>>) {
    const cells = [
      csv(r.master_sku),
      csv(r.product_name_en),
      csv(r.product_name_ar),
      csv((r.brand as { name: string } | null)?.name),
      csv((r.category as { name: string } | null)?.name),
      csv(r.product_type),
      csv(r.variant),
      csv(r.color),
      csv(r.size),
      csv(r.price),
      csv(r.discount_price),
      csv(r.stock_quantity),
      csv(r.stock_status),
      csv(r.product_status),
      csv(r.description_en),
      csv(r.description_ar),
      csv(r.usage_en),
      csv(r.usage_ar),
      csv((r.keywords_en as string[] | null)?.join('|')),
      csv((r.keywords_ar as string[] | null)?.join('|')),
      csv(r.image_url),
      csv(r.ai_confidence),
    ];
    lines.push(cells.join(','));
  }
  // UTF-8 BOM so Excel detects Arabic correctly
  const csvBody = '﻿' + lines.join('\n');

  const filename = `malikas-drafts-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csvBody, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function csv(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
