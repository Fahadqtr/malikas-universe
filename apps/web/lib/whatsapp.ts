/**
 * WhatsApp Cloud API client.
 *
 * Reads env vars (loaded lazily so the app boots without them):
 *   WHATSAPP_TOKEN          — long-lived access token from Meta
 *   WHATSAPP_PHONE_ID       — phone number ID (numeric, e.g. 123456789012345)
 *   WHATSAPP_VERIFY_TOKEN   — verify token you set in webhook config
 *   WHATSAPP_LIVE_ENABLED   — 'true' to auto-reply to inbound messages
 *                             (default: 'false' — webhook logs but doesn't reply)
 *
 * Endpoints used:
 *   POST https://graph.facebook.com/v22.0/{PHONE_ID}/messages
 *
 * Until creds are set, calls return { ok:false, reason:'not_configured' }
 * — the agent still works, the reply just isn't delivered.
 *
 * SAFETY:
 *   • isWhatsappLiveEnabled() must be true before webhook actually sends a reply.
 *   • All inbound + outbound events go through logWhatsappEvent() for audit.
 *   • Never log raw tokens — only configured/missing status.
 */
import { createAdminSupabaseClient } from '@/lib/supabase/server';

const API_VERSION = 'v22.0';
const BASE = 'https://graph.facebook.com';

function getCreds():
  | { ok: true; token: string; phone_id: string; verify_token: string }
  | { ok: false; reason: string } {
  const token = process.env.WHATSAPP_TOKEN;
  const phone_id = process.env.WHATSAPP_PHONE_ID;
  const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;
  const missing: string[] = [];
  if (!token) missing.push('WHATSAPP_TOKEN');
  if (!phone_id) missing.push('WHATSAPP_PHONE_ID');
  if (!verify_token) missing.push('WHATSAPP_VERIFY_TOKEN');
  if (missing.length > 0) {
    return { ok: false, reason: `WhatsApp not configured. Set: ${missing.join(', ')}` };
  }
  return { ok: true, token: token!, phone_id: phone_id!, verify_token: verify_token! };
}

/**
 * Returns the configured webhook verify token (or null).
 * Used by GET /api/whatsapp/webhook to compare against ?hub.verify_token=…
 */
export function getVerifyToken(): string | null {
  const c = getCreds();
  return c.ok ? c.verify_token : null;
}

/**
 * Send a plain-text message to a WhatsApp number.
 *
 *   to: E.164 phone, e.g. "+97412345678"
 *   body: message text (under 4096 chars)
 *
 * Returns { ok:true, wamid } on success, or { ok:false, reason, status? }.
 * Never throws — agent flow stays clean even on credential failures.
 */
export async function sendWhatsappText(opts: {
  to: string;
  body: string;
}): Promise<
  | { ok: true; wamid: string }
  | { ok: false; reason: string; status?: number }
> {
  const c = getCreds();
  if (!c.ok) return { ok: false, reason: c.reason };

  const url = `${BASE}/${API_VERSION}/${c.phone_id}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to.replace(/^\+/, ''),
    type: 'text',
    text: { preview_url: false, body: opts.body.slice(0, 4096) },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string };
    };
    if (!res.ok || !data.messages?.[0]?.id) {
      return {
        ok: false,
        status: res.status,
        reason: data.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true, wamid: data.messages[0].id };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network error' };
  }
}

/**
 * Parse the inbound webhook payload from Meta into a normalized message shape.
 * Returns null if the payload isn't a customer message (e.g. status update).
 *
 * Meta payload shape (simplified):
 *   { entry: [{ changes: [{ value: { messages: [...], contacts: [...] } }] }] }
 */
export function parseInboundWebhook(payload: unknown): {
  customer_phone: string;
  customer_name: string | null;
  message_body: string;
  media_url: string | null;
  wamid: string;
} | null {
  try {
    const entry = (payload as { entry?: unknown[] }).entry?.[0] as
      | { changes?: Array<{ value?: { messages?: unknown[]; contacts?: unknown[] } }> }
      | undefined;
    const value = entry?.changes?.[0]?.value;
    const msg = value?.messages?.[0] as
      | {
          from?: string;
          id?: string;
          type?: string;
          text?: { body?: string };
          image?: { caption?: string; id?: string };
        }
      | undefined;
    if (!msg || !msg.from || !msg.id) return null;
    const contact = value?.contacts?.[0] as { profile?: { name?: string } } | undefined;
    const body =
      msg.type === 'text'
        ? msg.text?.body ?? ''
        : msg.type === 'image'
          ? msg.image?.caption ?? '[image]'
          : `[unsupported message type: ${msg.type ?? 'unknown'}]`;
    return {
      customer_phone: '+' + msg.from.replace(/\D/g, ''),
      customer_name: contact?.profile?.name ?? null,
      message_body: body,
      media_url: null, // could fetch with a 2nd Meta API call — out of scope for v1
      wamid: msg.id,
    };
  } catch {
    return null;
  }
}

/**
 * Quick health-check — verifies credentials by hitting the phone number endpoint.
 * Returns the phone number details on success, OR a classified failure on error:
 *   kind: 'expired'    — token has expired or session timed out (Meta error 190)
 *   kind: 'invalid'    — token rejected by Meta (wrong format, wrong app, revoked)
 *   kind: 'permission' — token lacks the WhatsApp permissions
 *   kind: 'network'    — couldn't reach Meta
 *   kind: 'not_configured' — env vars missing
 *   kind: 'other'      — anything else
 *
 * Used by /api/whatsapp/status to drive the diagnostics panel + tell the
 * operator EXACTLY what's wrong (expired vs missing vs wrong permissions).
 */
export async function whatsappPing(): Promise<
  | { ok: true; phone_number: string; verified_name: string }
  | { ok: false; reason: string; kind: 'expired' | 'invalid' | 'permission' | 'network' | 'not_configured' | 'other'; code?: number }
> {
  const c = getCreds();
  if (!c.ok) return { ok: false, reason: c.reason, kind: 'not_configured' };

  try {
    const res = await fetch(`${BASE}/${API_VERSION}/${c.phone_id}`, {
      headers: { Authorization: `Bearer ${c.token}` },
    });
    const data = (await res.json()) as {
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string; code?: number; type?: string; error_subcode?: number };
    };
    if (!res.ok || !data.display_phone_number) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      const code = data.error?.code;
      // Meta error code 190 = OAuth token issues (expired/revoked/invalid)
      // Subcode 463 = expired specifically
      let kind: 'expired' | 'invalid' | 'permission' | 'other' = 'other';
      if (code === 190 || /session has expired|access token.*expired/i.test(msg)) {
        kind = 'expired';
      } else if (code === 190 || /invalid.*token|malformed/i.test(msg)) {
        kind = 'invalid';
      } else if (code === 200 || /permission|scope/i.test(msg)) {
        kind = 'permission';
      }
      return { ok: false, reason: msg, kind, code };
    }
    return {
      ok: true,
      phone_number: data.display_phone_number,
      verified_name: data.verified_name ?? '',
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network error', kind: 'network' };
  }
}

// ─── Live mode flag ─────────────────────────────────────────────────────────
/**
 * Is the agent allowed to send live replies through Meta?
 *
 * Default = FALSE. We require an EXPLICIT opt-in via env to prevent accidental
 * auto-replies during testing. Flip to true only after you've verified inbound
 * logging works and the AI reply tone is correct on /whatsapp-test.
 *
 * Toggle by setting WHATSAPP_LIVE_ENABLED=true in .env.local and restarting dev.
 */
export function isWhatsappLiveEnabled(): boolean {
  const v = (process.env.WHATSAPP_LIVE_ENABLED ?? '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/**
 * Public config status — what's set, what's missing.
 * NEVER returns the actual token. Only configured/missing flags + last-4 hint.
 *
 * Used by:
 *   - GET /api/whatsapp/status
 *   - /whatsapp-live page
 */
export function getWhatsappConfigStatus(): {
  token_configured: boolean;
  phone_id_configured: boolean;
  verify_token_configured: boolean;
  verify_token_hint: string;       // first/last chars only — for sanity check
  phone_id_hint: string;
  live_enabled: boolean;
  api_version: string;
} {
  const token = process.env.WHATSAPP_TOKEN ?? '';
  const phone_id = process.env.WHATSAPP_PHONE_ID ?? '';
  const verify_token = process.env.WHATSAPP_VERIFY_TOKEN ?? '';

  function hint(s: string): string {
    if (!s) return '';
    if (s.length <= 6) return '***';
    return `${s.slice(0, 3)}…${s.slice(-3)}`;
  }

  return {
    token_configured: token.length > 0,
    phone_id_configured: phone_id.length > 0,
    verify_token_configured: verify_token.length > 0,
    verify_token_hint: hint(verify_token),
    phone_id_hint: hint(phone_id),
    live_enabled: isWhatsappLiveEnabled(),
    api_version: API_VERSION,
  };
}

// ─── Webhook event logging ──────────────────────────────────────────────────
/**
 * Persist a webhook event (inbound or outbound) to whatsapp_webhook_logs.
 * Never throws — logging is best-effort, the calling route must continue.
 */
export async function logWhatsappEvent(opts: {
  direction: 'inbound' | 'outbound';
  phone: string | null;
  payload: unknown;
  status: 'received' | 'parsed' | 'skipped' | 'sent' | 'failed' | 'error';
  error_message?: string | null;
  wamid?: string | null;
  conversation_id?: number | null;
}): Promise<void> {
  try {
    const admin = createAdminSupabaseClient();
    await admin.from('whatsapp_webhook_logs').insert({
      direction: opts.direction,
      phone: opts.phone,
      payload: opts.payload ?? {},
      status: opts.status,
      error_message: opts.error_message ?? null,
      wamid: opts.wamid ?? null,
      conversation_id: opts.conversation_id ?? null,
      live_enabled: isWhatsappLiveEnabled(),
    });
  } catch (e) {
    // Last-resort fallback — server logs only, never blocks Meta ack.
    console.error('[whatsapp] failed to log event:', e);
  }
}

/**
 * Recent webhook log rows for the /whatsapp-live dashboard.
 * Returns up to `limit` rows ordered newest-first.
 */
export async function listRecentWebhookLogs(limit = 30): Promise<
  Array<{
    id: number;
    direction: 'inbound' | 'outbound';
    phone: string | null;
    status: string;
    error_message: string | null;
    wamid: string | null;
    conversation_id: number | null;
    live_enabled: boolean;
    created_at: string;
    payload_preview: string;       // truncated JSON for UI
  }>
> {
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from('whatsapp_webhook_logs')
      .select('id, direction, phone, status, error_message, wamid, conversation_id, live_enabled, created_at, payload')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100));
    if (error) {
      console.error('[whatsapp] listRecentWebhookLogs error:', error.message);
      return [];
    }
    return (data ?? []).map((r) => {
      const json = JSON.stringify(r.payload ?? {});
      return {
        id: r.id as number,
        direction: r.direction as 'inbound' | 'outbound',
        phone: r.phone as string | null,
        status: r.status as string,
        error_message: r.error_message as string | null,
        wamid: r.wamid as string | null,
        conversation_id: r.conversation_id as number | null,
        live_enabled: r.live_enabled as boolean,
        created_at: r.created_at as string,
        payload_preview: json.length > 280 ? json.slice(0, 280) + '…' : json,
      };
    });
  } catch (e) {
    console.error('[whatsapp] listRecentWebhookLogs crash:', e);
    return [];
  }
}
