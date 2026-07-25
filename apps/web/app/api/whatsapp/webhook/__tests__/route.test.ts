/**
 * Integration tests for the WhatsApp webhook POST handler.
 *
 * These assert the FAIL-CLOSED security contract end-to-end:
 *   - No side effects (no log / parse / AI / send) unless the HMAC verifies.
 *   - JSON is only parsed AFTER the signature passes.
 *   - Live-mode gate still governs auto-reply on a verified request.
 *
 * External modules are fully mocked — no Meta, no Supabase, no Claude, no
 * network. The REAL signature verifier (`@/lib/whatsapp-signature`) is used so
 * we sign requests locally with node:crypto, exactly as Meta would.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

// ─── Mock all external side-effecting collaborators ──────────────────────────
vi.mock('@/lib/whatsapp', () => ({
  logWhatsappEvent: vi.fn(async () => {}),
  parseInboundWebhook: vi.fn(),
  sendWhatsappText: vi.fn(async () => ({ ok: true, wamid: 'wamid.OUT' })),
  isWhatsappLiveEnabled: vi.fn(() => false),
  getVerifyToken: vi.fn(() => 'verify-token'),
}));
vi.mock('@/lib/agent/agent', () => ({
  runWhatsappAgent: vi.fn(async () => ({ reply: 'hello back', conversation_id: 7 })),
}));

// Import AFTER mocks are registered.
import { POST } from '../route';
import {
  logWhatsappEvent,
  parseInboundWebhook,
  sendWhatsappText,
  isWhatsappLiveEnabled,
} from '@/lib/whatsapp';
import { runWhatsappAgent } from '@/lib/agent/agent';

const APP_SECRET = 'test_app_secret_for_route';
const WEBHOOK_URL = 'http://localhost:3001/api/whatsapp/webhook';

/** A realistic Meta inbound-message body. */
const INBOUND_BODY = JSON.stringify({
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ profile: { name: 'Sara' } }],
            messages: [
              { from: '97455512345', id: 'wamid.IN1', type: 'text', text: { body: 'hi' } },
            ],
          },
        },
      ],
    },
  ],
});

/** The normalized shape parseInboundWebhook would return for INBOUND_BODY. */
const PARSED_MESSAGE = {
  customer_phone: '+97455512345',
  customer_name: 'Sara',
  message_body: 'hi',
  media_url: null,
  wamid: 'wamid.IN1',
};

function signature(body: string, secret: string = APP_SECRET): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(body, 'utf8'))
    .digest('hex');
  return `sha256=${digest}`;
}

function makeRequest(body: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(WEBHOOK_URL, { method: 'POST', body, headers });
}

/** Assert NONE of the side-effecting collaborators ran. */
function expectNoSideEffects() {
  expect(logWhatsappEvent).not.toHaveBeenCalled();
  expect(parseInboundWebhook).not.toHaveBeenCalled();
  expect(runWhatsappAgent).not.toHaveBeenCalled();
  expect(sendWhatsappText).not.toHaveBeenCalled();
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isWhatsappLiveEnabled).mockReturnValue(false);
  vi.mocked(parseInboundWebhook).mockReturnValue(PARSED_MESSAGE);
});

afterEach(() => {
  // Restore process.env to prevent state leaking between tests.
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('POST /api/whatsapp/webhook — HMAC fail-closed contract', () => {
  it('1. missing WHATSAPP_APP_SECRET → 503 and zero side effects', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const res = await POST(makeRequest(INBOUND_BODY, { 'x-hub-signature-256': signature(INBOUND_BODY) }));
    expect(res.status).toBe(503);
    expectNoSideEffects();
  });

  it('2. missing x-hub-signature-256 header → 401 and zero side effects', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    const res = await POST(makeRequest(INBOUND_BODY, {})); // no signature header
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('3. wrong signature → 401 and zero side effects', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    const bad = signature(INBOUND_BODY, 'the_wrong_secret');
    const res = await POST(makeRequest(INBOUND_BODY, { 'x-hub-signature-256': bad }));
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });

  it('4. valid signature + live mode OFF → 200, logged, no Claude, no send', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    vi.mocked(isWhatsappLiveEnabled).mockReturnValue(false);
    const res = await POST(
      makeRequest(INBOUND_BODY, { 'x-hub-signature-256': signature(INBOUND_BODY) }),
    );
    expect(res.status).toBe(200);
    // The inbound was parsed and logged...
    expect(parseInboundWebhook).toHaveBeenCalledTimes(1);
    expect(logWhatsappEvent).toHaveBeenCalled();
    // ...but no AI and no outbound message.
    expect(runWhatsappAgent).not.toHaveBeenCalled();
    expect(sendWhatsappText).not.toHaveBeenCalled();
  });

  it('5. valid signature + invalid JSON → parse only reached after HMAC; no Claude, no send; 200 ACK', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    const badJson = 'this is not json {';
    const res = await POST(
      makeRequest(badJson, { 'x-hub-signature-256': signature(badJson) }),
    );
    // Behaviour preserved: verified sender + bad JSON → log error + ACK 200.
    expect(res.status).toBe(200);
    // JSON.parse threw → parseInboundWebhook never reached; only the error log ran.
    expect(parseInboundWebhook).not.toHaveBeenCalled();
    expect(logWhatsappEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWhatsappEvent).mock.calls[0]?.[0]).toMatchObject({
      status: 'error',
    });
    // No AI, no outbound.
    expect(runWhatsappAgent).not.toHaveBeenCalled();
    expect(sendWhatsappText).not.toHaveBeenCalled();
  });

  it('6. valid signature + live mode ON → agent once, send once, no duplication, 200', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    vi.mocked(isWhatsappLiveEnabled).mockReturnValue(true);
    const res = await POST(
      makeRequest(INBOUND_BODY, { 'x-hub-signature-256': signature(INBOUND_BODY) }),
    );
    expect(res.status).toBe(200);
    expect(runWhatsappAgent).toHaveBeenCalledTimes(1);
    expect(sendWhatsappText).toHaveBeenCalledTimes(1);
  });

  it('bonus: a signature over re-serialized JSON (different bytes) is rejected → proves raw-body hashing', async () => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    // Sign a pretty-printed variant, but POST the compact bytes.
    const pretty = JSON.stringify(JSON.parse(INBOUND_BODY), null, 2);
    const res = await POST(
      makeRequest(INBOUND_BODY, { 'x-hub-signature-256': signature(pretty) }),
    );
    expect(res.status).toBe(401);
    expectNoSideEffects();
  });
});
