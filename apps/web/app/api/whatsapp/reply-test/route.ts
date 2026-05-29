/**
 * POST /api/whatsapp/reply-test
 *
 * Local-only test endpoint for the WhatsApp agent.
 * Runs the SAME agent logic as the live webhook, but does NOT send a message
 * over WhatsApp Cloud API — just returns the reply in JSON.
 *
 * Body:
 *   {
 *     customer_phone:   "+97412345678"   (required, fake or real)
 *     customer_name?:   string
 *     message_body:     "ابي ترطيب لبشرتي"  (required)
 *   }
 *
 * Returns:
 *   {
 *     conversation_id, reply, matched_products[], escalations[],
 *     tool_calls[], usage{tokens,cost,latency}, language
 *   }
 *
 * Auth: requires owner/editor role.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { runWhatsappAgent } from '@/lib/agent/agent';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Body = z.object({
  customer_phone: z.string().min(3).max(32),
  customer_name: z.string().max(120).optional(),
  message_body: z.string().min(1).max(4000),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot test the agent`, 403);
  }

  const body = Body.parse(await req.json());

  const result = await runWhatsappAgent({
    customer_phone: body.customer_phone,
    customer_name: body.customer_name,
    message_body: body.message_body,
  });

  return ok(result);
});
