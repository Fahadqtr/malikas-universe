-- ============================================================================
-- PHASE 12 — Realtime + Notifications
-- ============================================================================
-- Enables Supabase Realtime (logical replication → websockets) on the tables
-- the support dashboard subscribes to.
--
-- Adds:
--   1. Realtime publication membership for:
--        messages, conversations, support_notes, escalations, conversation_assignments
--   2. agent_conversation_reads  — per-agent unread tracking
--      (one row per (agent_id, conversation_id), updated on view)
--   3. notification_events       — server-emitted notifications history
--
-- Hard rules:
--   • Realtime only emits row changes to subscribers — no extra perf cost
--   • RLS is enforced through realtime too, so viewers can only see what
--     they can normally SELECT
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ─── 1. Enable realtime publication on the support tables ───────────────────
-- The supabase_realtime publication is created by Supabase by default.
-- We add tables to it idempotently.

DO $$
BEGIN
    -- messages
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname='supabase_realtime' AND tablename='messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE messages;
    END IF;
    -- conversations
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname='supabase_realtime' AND tablename='conversations'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
    END IF;
    -- support_notes
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname='supabase_realtime' AND tablename='support_notes'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE support_notes;
    END IF;
    -- escalations
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname='supabase_realtime' AND tablename='escalations'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE escalations;
    END IF;
    -- conversation_assignments
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname='supabase_realtime' AND tablename='conversation_assignments'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE conversation_assignments;
    END IF;
END $$;

-- Realtime requires REPLICA IDENTITY FULL on tables to receive UPDATE diffs
-- with old values. Without this we only get the new row.
ALTER TABLE messages                 REPLICA IDENTITY FULL;
ALTER TABLE conversations            REPLICA IDENTITY FULL;
ALTER TABLE support_notes            REPLICA IDENTITY FULL;
ALTER TABLE escalations              REPLICA IDENTITY FULL;
ALTER TABLE conversation_assignments REPLICA IDENTITY FULL;

-- ─── 2. agent_conversation_reads — per-agent unread tracking ───────────────
-- conversations.last_read_at was a global "anyone read it" timestamp.
-- For multi-agent dashboards we need per-agent reads.

CREATE TABLE IF NOT EXISTS agent_conversation_reads (
    agent_id        BIGINT NOT NULL REFERENCES support_agents(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id)   ON DELETE CASCADE,
    last_read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, conversation_id)
);

COMMENT ON TABLE agent_conversation_reads IS
    'Per-agent unread tracking. Updated when an agent opens a conversation. Unread = messages.created_at > last_read_at.';

CREATE INDEX IF NOT EXISTS idx_acr_agent
    ON agent_conversation_reads(agent_id, last_read_at DESC);

ALTER TABLE agent_conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acr_select ON agent_conversation_reads;
CREATE POLICY acr_select ON agent_conversation_reads FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS acr_write ON agent_conversation_reads;
CREATE POLICY acr_write ON agent_conversation_reads FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

-- ─── 3. notification_events — emitted server-side, consumed by the drawer ──
-- The dashboard polls/subscribes to this so even offline agents see history.

CREATE TABLE IF NOT EXISTS notification_events (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT NOT NULL
                    CHECK (kind IN (
                        'new_message','escalation','assignment',
                        'refund_issue','fake_claim','sla_breach','note_added'
                    )),
    severity        TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info','warning','critical')),
    title           TEXT NOT NULL,
    body            TEXT,
    conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
    target_agent    BIGINT REFERENCES support_agents(id) ON DELETE SET NULL,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    read_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notif_recent
    ON notification_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread
    ON notification_events(target_agent, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notif_select ON notification_events;
CREATE POLICY notif_select ON notification_events FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS notif_write ON notification_events;
CREATE POLICY notif_write ON notification_events FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

-- Add to realtime
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname='supabase_realtime' AND tablename='notification_events'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE notification_events;
    END IF;
END $$;

ALTER TABLE notification_events REPLICA IDENTITY FULL;

-- ─── 4. Force PostgREST reload ──────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ─── Verify ────────────────────────────────────────────────────────────────
-- SELECT tablename FROM pg_publication_tables
--  WHERE pubname='supabase_realtime'
--    AND tablename IN ('messages','conversations','support_notes','escalations',
--                      'conversation_assignments','notification_events');
-- -- expect 6 rows
--
-- SELECT count(*) FROM agent_conversation_reads;
-- SELECT count(*) FROM notification_events;
