/**
 * POST /api/support/conversations/[id]/notes
 *
 * Add an internal note (NEVER customer-visible).
 * Body: { body: string, kind?: 'note'|'action'|'escalation' }
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type Ctx = { params: { id: string } };

const Body = z.object({
  body: z.string().min(1).max(2000),
  kind: z.enum(['note', 'action', 'escalation']).default('note'),
});

export const POST = withErrorHandling(async (req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', 'Cannot write notes', 403);
  }

  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return err('BAD_ID', 'Invalid conversation id', 400);

  const body = Body.parse(await req.json());
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from('support_notes')
    .insert({
      conversation_id: id,
      body: body.body,
      kind: body.kind,
      author_email: actor.email,
      author_name: actor.email,
    })
    .select('id, created_at')
    .single();
  if (error) return err('INSERT_FAILED', error.message, 500);

  return ok(data);
});
