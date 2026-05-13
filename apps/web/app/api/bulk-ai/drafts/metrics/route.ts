/**
 * GET /api/bulk-ai/drafts/metrics
 *
 * Dashboard top-bar metrics for the review screen.
 *
 * Returns:
 *   {
 *     total_drafts,          // all ai_generated rows (including approved)
 *     pending_review,        // ai_generated + product_status='draft'
 *     approved_today,        // moved from draft → active today
 *     failed_ai,             // ai_meta->>'error_code' present
 *     avg_confidence,        // average ai_confidence over all ai_generated (0..1)
 *     cost_today_usd,        // sum of ai_usage_log.cost_usd today (bulk_ai_process*)
 *     cost_total_usd,        // sum of ai_usage_log.cost_usd all-time (bulk_ai_process*)
 *     processed_today,       // count of successful AI calls today
 *   }
 */
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor', 'viewer'].includes(actor.role)) {
    throw new Error('FORBIDDEN');
  }

  const admin = createAdminSupabaseClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  // ── Counts (parallel) ─────────────────────────────────────────────────────
  const [total, pending, approvedToday, failed, avgConfRow, usageToday, usageAll] = await Promise.all([
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .is('deleted_at', null),
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .eq('product_status', 'draft')
      .is('deleted_at', null),
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .eq('product_status', 'active')
      .gte('updated_at', todayIso)
      .is('deleted_at', null),
    admin
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('ai_generated', true)
      .not('ai_meta->>error_code', 'is', null)
      .is('deleted_at', null),
    admin
      .from('products')
      .select('ai_confidence')
      .eq('ai_generated', true)
      .not('ai_confidence', 'is', null)
      .is('deleted_at', null),
    admin
      .from('ai_usage_log')
      .select('cost_usd, success')
      .like('operation', 'bulk_ai_process%')
      .gte('created_at', todayIso),
    admin
      .from('ai_usage_log')
      .select('cost_usd')
      .like('operation', 'bulk_ai_process%')
      .eq('success', true),
  ]);

  // Average confidence — Postgres doesn't expose avg() through PostgREST easily
  // without an RPC, so compute client-side. Volume is small (<10k drafts).
  const confidences = (avgConfRow.data ?? [])
    .map((r) => Number(r.ai_confidence))
    .filter((n) => Number.isFinite(n));
  const avg_confidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

  const cost_today_usd = (usageToday.data ?? []).reduce(
    (s, r) => s + (Number(r.cost_usd) || 0),
    0,
  );
  const processed_today_success = (usageToday.data ?? []).filter((r) => r.success).length;
  const cost_total_usd = (usageAll.data ?? []).reduce(
    (s, r) => s + (Number(r.cost_usd) || 0),
    0,
  );

  return ok({
    total_drafts: total.count ?? 0,
    pending_review: pending.count ?? 0,
    approved_today: approvedToday.count ?? 0,
    failed_ai: failed.count ?? 0,
    avg_confidence: Number(avg_confidence.toFixed(3)),
    cost_today_usd: Number(cost_today_usd.toFixed(4)),
    cost_total_usd: Number(cost_total_usd.toFixed(4)),
    processed_today: processed_today_success,
  });
});
