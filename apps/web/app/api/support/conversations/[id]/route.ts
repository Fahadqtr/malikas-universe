/**
 * GET /api/support/conversations/[id]   — full thread + notes + tags + agent
 * PATCH /api/support/conversations/[id]  — update fields (status, priority,
 *                                           ai_enabled, assigned_to, tags)
 *
 * The PATCH endpoint is the central audit point for support-side changes.
 * Every state transition writes a system note so we can reconstruct who did
 * what later (per spec: ✓ log human actions).
 *
 * Calling PATCH also bumps last_read_at to NOW for the acting user — clears
 * the unread badge.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type Ctx = { params: { id: string } };

// ─── GET ─────────────────────────────────────────────────────────────────────

export const GET = withErrorHandling(async (_req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  if (!['owner', 'editor', 'viewer'].includes(actor.role)) return err('FORBIDDEN', 'Read denied', 403);

  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return err('BAD_ID', 'Invalid conversation id', 400);

  const admin = createAdminSupabaseClient();

  const { data: conv, error } = await admin
    .from('conversations')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return err('LOAD_FAILED', error.message, 500);
  if (!conv) return err('NOT_FOUND', 'Conversation not found', 404);

  const [{ data: msgs }, { data: notes }, { data: tags }, { data: agent }, { data: assignments }] =
    await Promise.all([
      admin
        .from('messages')
        .select('id, direction, body, media_url, ai_model, intent, tools_called, created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true })
        .limit(500),
      admin
        .from('support_notes')
        .select('id, body, author_email, author_name, kind, metadata, created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true })
        .limit(200),
      admin.from('conversation_tags').select('tag, added_by, created_at').eq('conversation_id', id),
      conv.assigned_to
        ? admin
            .from('support_agents')
            .select('id, display_name, email, role, avatar_url')
            .eq('id', conv.assigned_to)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      admin
        .from('conversation_assignments')
        .select('id, action, reason, actor_email, created_at, agent_id')
        .eq('conversation_id', id)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

  // Mark the conversation as read for current viewer
  void admin
    .from('conversations')
    .update({ last_read_at: new Date().toISOString() })
    .eq('id', id)
    .then(() => undefined);

  return ok({
    conversation: { ...conv, assigned_agent: agent ?? null },
    messages: msgs ?? [],
    notes: notes ?? [],
    tags: (tags ?? []).map((t) => ({ tag: t.tag, added_by: t.added_by, created_at: t.created_at })),
    assignment_log: assignments ?? [],
  });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────

const Patch = z.object({
  status: z.enum(['open', 'escalated', 'resolved', 'spam']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  ai_enabled: z.boolean().optional(),
  assigned_to: z.number().int().nullable().optional(), // null = unassign
  add_tag: z.string().min(1).max(40).optional(),
  remove_tag: z.string().min(1).max(40).optional(),
  resolved: z.boolean().optional(), // shortcut for status='resolved'+resolved_at
});

export const PATCH = withErrorHandling(async (req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot modify conversations`, 403);
  }

  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return err('BAD_ID', 'Invalid conversation id', 400);

  const body = Patch.parse(await req.json());
  const admin = createAdminSupabaseClient();

  // Load current state for delta-logging
  const { data: before, error: loadErr } = await admin
    .from('conversations')
    .select('id, status, priority, ai_enabled, assigned_to')
    .eq('id', id)
    .maybeSingle();
  if (loadErr || !before) return err('NOT_FOUND', 'Conversation not found', 404);

  // Build update payload
  const update: Record<string, unknown> = {};
  if (body.status !== undefined) update.status = body.status;
  if (body.priority !== undefined) update.priority = body.priority;
  if (body.ai_enabled !== undefined) update.ai_enabled = body.ai_enabled;
  if (body.assigned_to !== undefined) update.assigned_to = body.assigned_to;
  if (body.resolved) {
    update.status = 'resolved';
    update.resolved_at = new Date().toISOString();
  }

  // Apply primary update (if any)
  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin.from('conversations').update(update).eq('id', id);
    if (updErr) return err('UPDATE_FAILED', updErr.message, 500);
  }

  // Tag ops
  if (body.add_tag) {
    await admin
      .from('conversation_tags')
      .insert({ conversation_id: id, tag: body.add_tag, added_by: actor.email })
      .then(() => undefined);
  }
  if (body.remove_tag) {
    await admin
      .from('conversation_tags')
      .delete()
      .eq('conversation_id', id)
      .eq('tag', body.remove_tag);
  }

  // Audit notes for every meaningful change
  const auditNotes: Array<{ kind: string; body: string; metadata: Record<string, unknown> }> = [];
  if (body.status !== undefined && body.status !== before.status) {
    auditNotes.push({
      kind: 'system',
      body: `Status changed: ${before.status} → ${body.status}`,
      metadata: { action: 'status_change', from: before.status, to: body.status },
    });
  }
  if (body.priority !== undefined && body.priority !== before.priority) {
    auditNotes.push({
      kind: 'system',
      body: `Priority changed: ${before.priority} → ${body.priority}`,
      metadata: { action: 'priority_change', from: before.priority, to: body.priority },
    });
  }
  if (body.ai_enabled !== undefined && body.ai_enabled !== before.ai_enabled) {
    auditNotes.push({
      kind: 'system',
      body: body.ai_enabled
        ? '🤖 AI re-enabled — incoming messages will be auto-answered'
        : '👤 AI disabled — only human replies will be sent',
      metadata: { action: body.ai_enabled ? 'ai_enabled' : 'ai_disabled' },
    });
  }
  if (body.assigned_to !== undefined && body.assigned_to !== before.assigned_to) {
    auditNotes.push({
      kind: 'system',
      body: body.assigned_to
        ? `Assigned to agent #${body.assigned_to}`
        : `Unassigned${before.assigned_to ? ` from agent #${before.assigned_to}` : ''}`,
      metadata: { action: 'assignment_change', from: before.assigned_to, to: body.assigned_to },
    });

    // Mirror in conversation_assignments
    await admin.from('conversation_assignments').insert({
      conversation_id: id,
      agent_id: body.assigned_to ?? null,
      action: body.assigned_to
        ? before.assigned_to
          ? 'reassigned'
          : 'assigned'
        : 'unassigned',
      actor_email: actor.email,
    });
  }
  if (body.resolved) {
    auditNotes.push({
      kind: 'system',
      body: '✓ Conversation marked resolved',
      metadata: { action: 'resolved' },
    });
  }
  if (body.add_tag) {
    auditNotes.push({
      kind: 'system',
      body: `Tagged: ${body.add_tag}`,
      metadata: { action: 'tag_added', tag: body.add_tag },
    });
  }
  if (body.remove_tag) {
    auditNotes.push({
      kind: 'system',
      body: `Tag removed: ${body.remove_tag}`,
      metadata: { action: 'tag_removed', tag: body.remove_tag },
    });
  }

  if (auditNotes.length > 0) {
    await admin.from('support_notes').insert(
      auditNotes.map((n) => ({
        conversation_id: id,
        body: n.body,
        kind: n.kind,
        author_email: actor.email,
        author_name: actor.email,
        metadata: n.metadata,
      })),
    );
  }

  return ok({ id, applied: Object.keys(update), audit_notes: auditNotes.length });
});
