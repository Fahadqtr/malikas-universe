/**
 * POST /api/snoonu-browser-audit/next-batch
 *
 * Returns the next N pending audits prioritized by audit_priority, with the
 * fields Claude needs to drive Chrome (queue product name for search +
 * audit_id + product_id).
 *
 * Body:
 *   { import_id: number, batch_size?: number (default 50, max 100) }
 *
 * Returns:
 *   {
 *     batch: [
 *       { audit_id, product_id, queue_product_name, queue_product_sku, audit_priority, audit_reason }
 *     ],
 *     batch_size: number,
 *     remaining_pending: number
 *   }
 *
 * READ-ONLY. Doesn't lock or modify any audit row — Claude can fetch the
 * batch, run through it, and each individual save-from-browser call
 * updates the audit lifecycle.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const Schema = z.object({
  import_id: z.number().int(),
  batch_size: z.number().int().min(1).max(100).optional(),
  reason: z.string().optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());
  const batchSize = body.batch_size ?? 50;

  const admin = createAdminSupabaseClient();

  let q = admin
    .from('snoonu_browser_audits')
    .select(
      `id, product_id, audit_priority, audit_reason, audit_status,
       product:platform_products!product_id (id, source_sku, name_en, name_ar, normalized_name, price)`,
    )
    .eq('import_id', body.import_id)
    .eq('audit_status', 'pending')
    .order('audit_priority', { ascending: true })
    .order('id', { ascending: true })
    .limit(batchSize);

  if (body.reason) q = q.eq('audit_reason', body.reason);

  const { data, error } = await q;
  if (error) return err('QUERY_FAILED', error.message, 500);

  const { count: remainingCount } = await admin
    .from('snoonu_browser_audits')
    .select('id', { count: 'exact', head: true })
    .eq('import_id', body.import_id)
    .eq('audit_status', 'pending');

  const batch = ((data ?? []) as unknown as Array<{
    id: number;
    product_id: number;
    audit_priority: number;
    audit_reason: string | null;
    audit_status: string;
    product: { id: number; source_sku: string | null; name_en: string | null; name_ar: string | null; normalized_name: string | null; price: number | null } | null;
  }>).map((row) => ({
    audit_id: row.id,
    product_id: row.product_id,
    queue_product_name: row.product?.name_en ?? row.product?.normalized_name ?? null,
    queue_product_name_ar: row.product?.name_ar ?? null,
    queue_product_sku: row.product?.source_sku ?? null,
    queue_product_price: row.product?.price ?? null,
    audit_priority: row.audit_priority,
    audit_reason: row.audit_reason,
  }));

  return ok({
    batch,
    batch_size: batch.length,
    remaining_pending: (remainingCount ?? 0) - batch.length,
    rules: {
      auto_apply_threshold: 0.95,
      needs_review_threshold: 0.75,
      read_only_safety: [
        'Do NOT click Save / Submit / Publish / Update Stock / Update Status / Update Price',
        'Read tabs only — General Details / Availability & Price / Choice Groups',
        'Stop immediately on login challenge or page structure change',
      ],
    },
  });
});
