/**
 * Meta WhatsApp Cloud API webhook.
 *
 *   GET  — handshake verification (Meta sends ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…)
 *   POST — inbound customer messages
 *
 * SAFETY GATES:
 *   1. Logging is ALWAYS on — every payload is recorded in whatsapp_webhook_logs.
 *   2. AI auto-reply only fires when WHATSAPP_LIVE_ENABLED=true.
 *      → If false, we ack Meta (200) + log the inbound, but DO NOT call the
 *        agent or send a reply. This lets you point Meta at your tunnel and
 *        verify the wiring is correct before enabling automation.
 *
 * SECURITY:
 *   • GET checks ?hub.verify_token against WHATSAPP_VERIFY_TOKEN env
 *     (the handshake string you invent in Meta's webhook config).
 *   • POST verifies the X-Hub-Signature-256 HMAC against WHATSAPP_APP_SECRET
 *     (the Meta *App Secret* — a DIFFERENT value from WHATSAPP_VERIFY_TOKEN and
 *     from WHATSAPP_TOKEN) BEFORE parsing, logging, or acting on any payload.
 *     See docs/whatsapp-live-setup.md and:
 *     https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-business-messaging#validating-payloads
 *
 * FAIL CLOSED — the POST handler rejects anything it cannot cryptographically
 * attribute to Meta, and does so BEFORE touching the database, the AI agent, or
 * the Graph API:
 *   • WHATSAPP_APP_SECRET not configured → 503, no processing, no logging.
 *   • Missing / malformed / mismatched signature → 401, no processing, no
 *     logging of the payload, no AI call, no outbound message.
 *   • Valid signature → the normal flow runs (still gated by
 *     WHATSAPP_LIVE_ENABLED for auto-reply).
 * There is deliberately NO bypass (no dev skip, no "live mode off" shortcut,
 * no fallback to another secret): even in log-only mode we first prove the
 * request came from Meta.
 *
 * Run /api/whatsapp/reply-test locally first to verify the agent works, then
 * set env vars (incl. WHATSAPP_APP_SECRET) + register this URL in Meta:
 *   https://your-tunnel.loca.lt/api/whatsapp/webhook
 *
 * See: docs/whatsapp-live-setup.md
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  getVerifyToken,
  isWhatsappLiveEnabled,
  logWhatsappEvent,
  parseInboundWebhook,
  sendWhatsappText,
} from '@/lib/whatsapp';
import { verifyWhatsappWebhookSignature } from '@/lib/whatsapp-signature';
import { runWhatsappAgent } from '@/lib/agent/agent';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── GET — Meta webhook verification ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') ?? '';

  const expected = getVerifyToken();
  if (!expected) {
    return new NextResponse('WhatsApp webhook not configured (missing env)', { status: 200 });
  }

  if (mode === 'subscribe' && token === expected) {
    // Meta wants the challenge echoed back as plain text
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new NextResponse('Verification failed', { status: 403 });
}

// ─── POST — Inbound customer message ─────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ─── STEP 1: read the RAW body exactly once ──────────────────────────────
  // We MUST hash the exact bytes Meta signed. Using req.json() would re-parse
  // and re-serialize, changing whitespace/ordering and breaking the HMAC match,
  // so we read the raw text and only JSON.parse AFTER the signature is verified.
  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  // ─── STEP 2: fail closed — verify BEFORE parsing/logging/DB/AI/send ───────
  const verdict = verifyWhatsappWebhookSignature(rawBody, signature, appSecret);
  if (!verdict.valid) {
    if (verdict.reason === 'app_secret_missing') {
      // Server misconfigured — cannot attribute the request to Meta.
      // Do NOT parse or persist anything. Generic message only (no secret, no body).
      console.error(
        '[whatsapp] webhook POST rejected: WHATSAPP_APP_SECRET is not configured',
      );
      return NextResponse.json(
        { ok: false, error: 'webhook not configured' },
        { status: 503 },
      );
    }
    // Missing / malformed / wrong-algo / wrong-length / mismatched signature.
    // Generic log line only — never the App Secret, the signature, the body,
    // or the customer's phone. No DB write, no AI, no outbound message.
    console.warn('[whatsapp] webhook signature verification failed');
    return NextResponse.json(
      { ok: false, error: 'invalid signature' },
      { status: 401 },
    );
  }

  // ─── STEP 3: signature verified → NOW it is safe to parse the raw body ────
  // Meta requires us to return 200 quickly. If processing takes too long,
  // Meta retries and we end up replying to the same message twice.
  // Strategy: log inline, agent call inline (fast enough for <1 msg/sec).
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Bad JSON from a signature-verified sender — log and ack
    await logWhatsappEvent({
      direction: 'inbound',
      phone: null,
      payload: { raw: 'invalid json' },
      status: 'error',
      error_message: 'failed to parse webhook body as JSON',
    });
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  // Always record the raw inbound payload (verbatim, for debugging Meta quirks)
  const parsed = parseInboundWebhook(payload);

  if (!parsed) {
    // Status update / read receipt / delivery confirmation / etc — log + ack
    await logWhatsappEvent({
      direction: 'inbound',
      phone: null,
      payload,
      status: 'skipped',
    });
    return NextResponse.json({ ok: true, skipped: true }, { status: 200 });
  }

  // Log the parsed customer message
  await logWhatsappEvent({
    direction: 'inbound',
    phone: parsed.customer_phone,
    payload,
    status: 'parsed',
    wamid: parsed.wamid,
  });

  // ─── SAFETY GATE ─────────────────────────────────────────────────────────
  // If live mode is off: ACK Meta + return. No agent call, no outbound message.
  // The inbound is now safely logged → you can view it on /whatsapp-live.
  if (!isWhatsappLiveEnabled()) {
    return NextResponse.json(
      {
        ok: true,
        live_enabled: false,
        note: 'inbound logged; auto-reply disabled (set WHATSAPP_LIVE_ENABLED=true to enable)',
      },
      { status: 200 },
    );
  }

  // ─── LIVE MODE — run agent + send reply ──────────────────────────────────
  try {
    const result = await runWhatsappAgent({
      customer_phone: parsed.customer_phone,
      customer_name: parsed.customer_name ?? undefined,
      message_body: parsed.message_body,
      media_url: parsed.media_url ?? undefined,
    });

    // Send the AI reply back over WhatsApp.
    // sendWhatsappText returns ok:false when creds are missing — non-fatal
    // (the reply is already saved in our DB, can be replayed later).
    const send = await sendWhatsappText({
      to: parsed.customer_phone,
      body: result.reply,
    });

    await logWhatsappEvent({
      direction: 'outbound',
      phone: parsed.customer_phone,
      payload: { reply_preview: result.reply.slice(0, 200), wamid: send.ok ? send.wamid : null },
      status: send.ok ? 'sent' : 'failed',
      error_message: send.ok ? null : send.reason,
      wamid: send.ok ? send.wamid : null,
      conversation_id: result.conversation_id ?? null,
    });

    if (!send.ok) {
      console.error('[whatsapp] send failed:', send.reason);
    }

    return NextResponse.json(
      { ok: true, conversation_id: result.conversation_id, sent: send.ok },
      { status: 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    console.error('[whatsapp] agent crash:', e);
    await logWhatsappEvent({
      direction: 'inbound',
      phone: parsed.customer_phone,
      payload,
      status: 'error',
      error_message: msg,
    });
    // Always return 200 so Meta doesn't keep retrying
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
