/**
 * POST /api/whatsapp/send-test
 *
 * Manually send a WhatsApp message via Meta Cloud API.
 * Used by /whatsapp-live to verify the outbound path works end-to-end
 * BEFORE flipping WHATSAPP_LIVE_ENABLED=true.
 *
 * Body:
 *   {
 *     to:      "+97412345678",  (E.164 required)
 *     message: "Hello from Malika"  (text body, ≤ 4096 chars)
 *   }
 *
 * Returns:
 *   ok: { wamid, to }
 *   err: structured error from Meta API
 *
 * Auth:
 *   • Owner only — sends real money/messages through Meta.
 *   • Logs every attempt (success or failure) to whatsapp_webhook_logs.
 *
 * NOTE: This endpoint works EVEN WHEN WHATSAPP_LIVE_ENABLED=false. It's an
 * explicit, owner-triggered send — separate from the auto-reply gate.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { logWhatsappEvent, sendWhatsappText } from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const maxDuration = 30;

const Body = z.object({
  to: z.string().min(7).max(32).regex(/^\+?\d+$/, 'must be digits, optional leading +'),
  message: z.string().min(1).max(4096),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (actor.role !== 'owner') {
    return err('FORBIDDEN', `Role ${actor.role} cannot send test WhatsApp messages`, 403);
  }

  const body = Body.parse(await req.json());
  const to = body.to.startsWith('+') ? body.to : '+' + body.to;

  const result = await sendWhatsappText({ to, body: body.message });

  // Always log — success or failure
  await logWhatsappEvent({
    direction: 'outbound',
    phone: to,
    payload: {
      mode: 'send-test',
      triggered_by: actor.email,
      reply_preview: body.message.slice(0, 200),
    },
    status: result.ok ? 'sent' : 'failed',
    error_message: result.ok ? null : result.reason,
    wamid: result.ok ? result.wamid : null,
  });

  if (!result.ok) {
    return err(
      'WHATSAPP_SEND_FAILED',
      result.reason,
      result.status && result.status >= 400 && result.status < 500 ? 400 : 502,
      { meta_status: result.status },
    );
  }

  return ok({
    wamid: result.wamid,
    to,
    note: 'Message sent. Check the customer\'s WhatsApp to confirm delivery.',
  });
});
