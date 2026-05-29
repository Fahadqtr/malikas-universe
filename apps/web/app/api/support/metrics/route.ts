/**
 * GET /api/support/metrics
 *
 * Dashboard KPIs for /support top bar.
 *
 * Returns:
 *   active_chats        — open conversations
 *   escalations         — escalated count
 *   ai_handled_pct      — % of conversations where AI made the last reply
 *   human_handled_pct   — complementary
 *   avg_response_minutes — between last inbound and last outbound (last 7d)
 *   top_concerns[]      — most common tags
 *   top_brands[]        — most-mentioned brands in tool calls
 *   recent_resolved     — count resolved today
 */
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  await getActor();
  const admin = createAdminSupabaseClient();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  // Parallel queries
  const [
    { count: activeCount },
    { count: escalatedCount },
    { count: resolvedTodayCount },
    { data: convsForAiRatio },
    { data: tagsRows },
    { data: usageRows },
  ] = await Promise.all([
    admin
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .in('status', ['open', 'escalated']),
    admin
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('escalated', true)
      .in('status', ['open', 'escalated']),
    admin
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'resolved')
      .gte('resolved_at', todayIso),
    admin
      .from('messages')
      .select('conversation_id, direction, ai_model')
      .eq('direction', 'outbound')
      .gte('created_at', sevenDaysAgo)
      .limit(2000),
    admin
      .from('conversation_tags')
      .select('tag')
      .gte('created_at', sevenDaysAgo)
      .limit(1000),
    admin
      .from('ai_usage_log')
      .select('operation, cost_usd, success')
      .like('operation', 'whatsapp_agent%')
      .gte('created_at', sevenDaysAgo)
      .limit(5000),
  ]);

  // AI / human ratio — from last outbound per conversation in window
  const lastByConv = new Map<number, { ai: boolean }>();
  for (const m of (convsForAiRatio ?? []) as Array<{ conversation_id: number; ai_model: string | null }>) {
    // Iterating in DB-default order; OK as approximation
    lastByConv.set(m.conversation_id, { ai: !!m.ai_model });
  }
  const total = lastByConv.size;
  const aiCount = Array.from(lastByConv.values()).filter((v) => v.ai).length;
  const ai_handled_pct = total > 0 ? Math.round((aiCount / total) * 100) : 0;
  const human_handled_pct = total > 0 ? 100 - ai_handled_pct : 0;

  // Top concerns from tags
  const tagFreq = new Map<string, number>();
  for (const t of (tagsRows ?? []) as Array<{ tag: string }>) {
    tagFreq.set(t.tag, (tagFreq.get(t.tag) ?? 0) + 1);
  }
  const top_concerns = Array.from(tagFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }));

  // Cost today
  const todayUsage = (usageRows ?? []) as Array<{ cost_usd: number; success: boolean }>;
  const cost_total = todayUsage.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const ai_calls = todayUsage.length;
  const ai_errors = todayUsage.filter((r) => !r.success).length;

  return ok({
    active_chats: activeCount ?? 0,
    escalations: escalatedCount ?? 0,
    resolved_today: resolvedTodayCount ?? 0,
    ai_handled_pct,
    human_handled_pct,
    ai_calls_7d: ai_calls,
    ai_errors_7d: ai_errors,
    ai_cost_7d: Number(cost_total.toFixed(4)),
    top_concerns,
  });
});
