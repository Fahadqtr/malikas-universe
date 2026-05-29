/**
 * GET /api/support/conversations
 *
 * Sidebar conversation list. Filters + search.
 *
 * Query params:
 *   status    open | escalated | resolved | spam | all   (default: open)
 *   priority  low | medium | high | urgent | all
 *   assigned  unassigned | me | <agent_id> | all          (default: all)
 *   q         search across customer_phone, customer_name, last message body
 *   limit, offset
 *
 * Returns each conversation with derived counters:
 *   - last_message_body (preview)
 *   - last_message_direction
 *   - unread_count (messages newer than last_read_at)
 *   - tags[]
 *   - assigned_name
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const Query = z.object({
  status: z.enum(['open', 'escalated', 'resolved', 'spam', 'all']).default('open'),
  priority: z.enum(['low', 'medium', 'high', 'urgent', 'all']).default('all'),
  assigned: z.string().default('all'),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor', 'viewer'].includes(actor.role)) {
    throw new Error('FORBIDDEN');
  }

  const params = Object.fromEntries(req.nextUrl.searchParams);
  const q = Query.parse(params);
  const admin = createAdminSupabaseClient();

  // Resolve "me" → agent_id for current actor
  let meAgentId: number | null = null;
  if (q.assigned === 'me' && actor.email) {
    const { data } = await admin
      .from('support_agents')
      .select('id')
      .eq('email', actor.email)
      .maybeSingle();
    meAgentId = data?.id ?? null;
  }

  let query = admin
    .from('conversations')
    .select(
      `id, customer_phone, customer_name, language, status, escalated,
       priority, ai_enabled, assigned_to, last_message_at, last_read_at,
       total_messages, created_at, resolved_at`,
      { count: 'exact' },
    );

  if (q.status !== 'all') query = query.eq('status', q.status);
  if (q.priority !== 'all') query = query.eq('priority', q.priority);
  if (q.assigned === 'unassigned') query = query.is('assigned_to', null);
  else if (q.assigned === 'me' && meAgentId) query = query.eq('assigned_to', meAgentId);
  else if (q.assigned !== 'all' && q.assigned !== 'me') {
    const aid = Number(q.assigned);
    if (Number.isFinite(aid)) query = query.eq('assigned_to', aid);
  }
  if (q.q) {
    query = query.or(
      `customer_phone.ilike.%${q.q}%,customer_name.ilike.%${q.q}%`,
    );
  }

  // Always sort by last activity, urgency-first inside
  query = query
    .order('priority', { ascending: false }) // urgent → low alphabetically lol — fix below
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range(q.offset, q.offset + q.limit - 1);

  const { data, count, error } = await query;
  if (error) throw new Error(`LIST_FAILED: ${error.message}`);

  const conversations = (data ?? []) as Array<{
    id: number;
    customer_phone: string;
    customer_name: string | null;
    language: string | null;
    status: string;
    escalated: boolean;
    priority: string;
    ai_enabled: boolean;
    assigned_to: number | null;
    last_message_at: string | null;
    last_read_at: string | null;
    total_messages: number;
    created_at: string;
    resolved_at: string | null;
  }>;

  // Enrich: last message preview + unread count + tags + agent name
  const enriched = await Promise.all(
    conversations.map(async (c) => {
      const [{ data: lastMsg }, { count: unread }, { data: tags }, { data: agent }] = await Promise.all([
        admin
          .from('messages')
          .select('direction, body, created_at')
          .eq('conversation_id', c.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        admin
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', c.id)
          .eq('direction', 'inbound')
          .gt('created_at', c.last_read_at ?? '1970-01-01'),
        admin
          .from('conversation_tags')
          .select('tag')
          .eq('conversation_id', c.id),
        c.assigned_to
          ? admin
              .from('support_agents')
              .select('display_name, email')
              .eq('id', c.assigned_to)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      return {
        ...c,
        last_message_body: lastMsg?.body ?? null,
        last_message_direction: lastMsg?.direction ?? null,
        unread_count: unread ?? 0,
        tags: (tags ?? []).map((t) => t.tag),
        assigned_name: agent?.display_name ?? agent?.email ?? null,
      };
    }),
  );

  // Manual priority sort: urgent > high > medium > low
  const order = { urgent: 0, high: 1, medium: 2, low: 3 };
  enriched.sort((a, b) => {
    const pa = order[a.priority as keyof typeof order] ?? 99;
    const pb = order[b.priority as keyof typeof order] ?? 99;
    if (pa !== pb) return pa - pb;
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return tb - ta;
  });

  return ok({
    items: enriched,
    total: count ?? 0,
    limit: q.limit,
    offset: q.offset,
  });
});
