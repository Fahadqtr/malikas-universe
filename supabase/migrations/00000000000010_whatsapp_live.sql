-- ============================================================================
-- MIGRATION 0010 — WhatsApp Live (Meta Cloud API)
-- ============================================================================
-- Adds infrastructure for connecting the WhatsApp AI Agent to a REAL
-- WhatsApp Business number via Meta Cloud API.
--
-- Adds:
--   1. whatsapp_webhook_logs  — every inbound/outbound payload, for debugging
--                               + audit (never trust Meta's history, keep our own)
--   2. Indexes for fast log lookup by phone, direction, status, created_at
--
-- Does NOT enable live replies. Live mode is controlled by the
-- WHATSAPP_LIVE_ENABLED env var (default: false). See:
--   docs/whatsapp-live-setup.md
--   apps/web/lib/whatsapp.ts → isWhatsappLiveEnabled()
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. whatsapp_webhook_logs ───────────────────────────────────────────────
-- One row per webhook event (inbound from Meta) OR outbound send attempt.
--
-- direction:
--   'inbound'   — POST /api/whatsapp/webhook received from Meta
--   'outbound'  — we called Meta's /messages endpoint
--
-- status:
--   'received'  — inbound payload accepted (we ack'd Meta)
--   'parsed'    — inbound payload was a valid customer message
--   'skipped'   — inbound was a status update / read receipt / etc (ignored)
--   'sent'      — outbound message accepted by Meta (got wamid)
--   'failed'    — outbound rejected by Meta (see error_message)
--   'error'     — exception thrown processing this event
--
-- Retention: keep ~30 days, trim with a scheduled job later if it grows.

CREATE TABLE IF NOT EXISTS whatsapp_webhook_logs (
    id              BIGSERIAL PRIMARY KEY,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    phone           TEXT,                       -- E.164, NULL for status-only payloads
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL CHECK (status IN ('received','parsed','skipped','sent','failed','error')),
    error_message   TEXT,
    wamid           TEXT,                       -- Meta's message id when present
    conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
    live_enabled    BOOLEAN NOT NULL DEFAULT false,  -- was WHATSAPP_LIVE_ENABLED at the time?
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes — log lookups happen 3 ways: recent (created_at desc), by phone, by direction+status
CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_created_at
    ON whatsapp_webhook_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_phone
    ON whatsapp_webhook_logs (phone, created_at DESC)
    WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_direction_status
    ON whatsapp_webhook_logs (direction, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_logs_conversation
    ON whatsapp_webhook_logs (conversation_id, created_at DESC)
    WHERE conversation_id IS NOT NULL;

COMMENT ON TABLE whatsapp_webhook_logs IS
  'Audit log of every WhatsApp Cloud API event (inbound webhook + outbound send). Kept independently of Meta.';
COMMENT ON COLUMN whatsapp_webhook_logs.live_enabled IS
  'Snapshot of WHATSAPP_LIVE_ENABLED env at the moment of the event. Helps reconstruct why a message was/wasn''t auto-replied.';

-- ─── 2. RLS: only authenticated users (admin app) can read ─────────────────
ALTER TABLE whatsapp_webhook_logs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (already the case), but explicit policy for
-- the user-token client used by API routes via getActor():
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='whatsapp_webhook_logs'
           AND policyname='whatsapp_logs_authenticated_read'
    ) THEN
        CREATE POLICY whatsapp_logs_authenticated_read
            ON whatsapp_webhook_logs
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;
END $$;

-- No INSERT/UPDATE/DELETE policy — writes happen via service role only.
