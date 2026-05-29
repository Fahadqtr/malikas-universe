/**
 * GET /api/whatsapp/status
 *
 * Returns WhatsApp Cloud API configuration status + Meta phone ping + recent logs.
 *
 * Used by /whatsapp-live page to show:
 *   - Which env vars are set (NEVER the actual token)
 *   - Whether Meta accepts our token (ping endpoint with kind: expired/invalid/etc)
 *   - Last inbound + outbound event timestamps for the checklist
 *   - Last 30 webhook events
 *   - Live mode flag
 *
 * Auth: owner or editor.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import {
  getWhatsappConfigStatus,
  isWhatsappLiveEnabled,
  listRecentWebhookLogs,
  whatsappPing,
} from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const maxDuration = 15;

export const GET = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot read WhatsApp status`, 403);
  }

  const config = getWhatsappConfigStatus();
  const live_enabled = isWhatsappLiveEnabled();

  // Only ping Meta if creds appear configured — saves a network call
  const ping =
    config.token_configured && config.phone_id_configured
      ? await whatsappPing()
      : { ok: false as const, reason: 'creds not configured', kind: 'not_configured' as const };

  const limit = Number(req.nextUrl.searchParams.get('logs') ?? '30');
  const logs = await listRecentWebhookLogs(isFinite(limit) ? limit : 30);

  // ─── Checklist values ────────────────────────────────────────────────────
  // Find the last inbound + last outbound from the logs we already loaded.
  const last_inbound = logs.find((l) => l.direction === 'inbound') ?? null;
  const last_outbound = logs.find((l) => l.direction === 'outbound') ?? null;

  // Webhook verified is implied if Meta ping is OK AND we have a log row that
  // came from Meta (any inbound). We can't directly check Meta's webhook state,
  // so we use ping-success + recent inbound activity as proxy.
  const checklist = {
    token_set: config.token_configured,
    phone_id_set: config.phone_id_configured,
    verify_token_set: config.verify_token_configured,
    token_valid: ping.ok,
    token_expired: !ping.ok && ping.kind === 'expired',
    webhook_likely_verified: ping.ok,    // best proxy we have without calling Meta's app config endpoint
    messages_subscribed: !!last_inbound, // we know subscription works if we've ever received a message
    live_enabled,
    last_inbound_at: last_inbound?.created_at ?? null,
    last_inbound_phone: last_inbound?.phone ?? null,
    last_outbound_at: last_outbound?.created_at ?? null,
    last_outbound_status: last_outbound?.status ?? null,
  };

  // Webhook URL hint — built from the request origin so it works behind tunnels.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const webhook_url = host ? `${proto}://${host}/api/whatsapp/webhook` : '';

  return ok({
    config,
    live_enabled,
    ping,
    webhook_url,
    actor_role: actor.role,
    checklist,
    logs,
  });
});
