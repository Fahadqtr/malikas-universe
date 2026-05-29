-- ============================================================================
-- PHASE 11 — Customer Support Dashboard
-- ============================================================================
-- Adds:
--   1. New columns on `conversations` (ai_enabled, priority, assigned_to,
--      resolved_at, last_read_at, internal_tags)
--   2. support_agents          — staff who handle conversations
--   3. conversation_assignments — assignment history (who took what)
--   4. support_notes           — internal staff notes per conversation
--   5. conversation_tags       — free-form tags for filtering
--
-- Hard rules baked in:
--   • AI on/off is per-conversation (default ON)
--   • Priority enum: low/medium/high/urgent
--   • Notes are NEVER customer-visible (no FK to messages)
--   • Every status/priority change can be audit-logged via DB trigger later
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ─── 1. New columns on conversations ────────────────────────────────────────

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS ai_enabled       BOOLEAN DEFAULT TRUE;
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS priority         TEXT DEFAULT 'medium'
                            CHECK (priority IN ('low','medium','high','urgent'));
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS assigned_to      BIGINT;
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS last_read_at     TIMESTAMPTZ;
ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS internal_tags    TEXT[];

COMMENT ON COLUMN conversations.ai_enabled IS
    'When TRUE, incoming customer messages are auto-answered by the AI agent. When FALSE, only human staff replies are sent. Toggle via the support dashboard.';
COMMENT ON COLUMN conversations.priority IS
    'Staff-set priority for the support queue.';
COMMENT ON COLUMN conversations.assigned_to IS
    'support_agents.id of the staff member currently owning this conversation.';
COMMENT ON COLUMN conversations.last_read_at IS
    'Last time a staff member opened this conversation — used for unread badge.';

-- ─── 2. support_agents ─────────────────────────────────────────────────────
-- One row per staff member who handles customer support.
-- Linked to user_profiles (auth user) so the same login can be the agent.

CREATE TABLE IF NOT EXISTS support_agents (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    email           TEXT UNIQUE NOT NULL,
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'agent'
                    CHECK (role IN ('agent','lead','admin')),
    languages       TEXT[] DEFAULT ARRAY['ar','en'],
    is_active       BOOLEAN DEFAULT TRUE,
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE support_agents IS
    'Staff members authorized to handle customer support. Linked to auth.users via user_id.';

CREATE INDEX IF NOT EXISTS idx_support_agents_active
    ON support_agents(is_active) WHERE is_active = TRUE;

-- Add FK now that the table exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name='conversations'
           AND constraint_name='conversations_assigned_to_fk'
    ) THEN
        ALTER TABLE conversations
            ADD CONSTRAINT conversations_assigned_to_fk
            FOREIGN KEY (assigned_to) REFERENCES support_agents(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ─── 3. conversation_assignments ───────────────────────────────────────────
-- Append-only log of every (re)assignment for audit. The current owner is
-- conversations.assigned_to; this table records who held it WHEN.

CREATE TABLE IF NOT EXISTS conversation_assignments (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id        BIGINT REFERENCES support_agents(id) ON DELETE SET NULL,
    action          TEXT NOT NULL CHECK (action IN ('assigned','unassigned','reassigned','released')),
    reason          TEXT,
    actor_email     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_assign_conv
    ON conversation_assignments(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_assign_agent
    ON conversation_assignments(agent_id, created_at DESC);

-- ─── 4. support_notes ──────────────────────────────────────────────────────
-- Internal staff notes. NEVER shown to the customer.

CREATE TABLE IF NOT EXISTS support_notes (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    body            TEXT NOT NULL,
    author_email    TEXT NOT NULL,
    author_name     TEXT,
    kind            TEXT NOT NULL DEFAULT 'note'
                    CHECK (kind IN ('note','system','action','escalation')),
    visible_to_customer BOOLEAN DEFAULT FALSE,   -- enforced FALSE everywhere
    metadata        JSONB,                        -- e.g. {"action":"ai_disabled","reason":"customer requested"}
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN support_notes.visible_to_customer IS
    'Always FALSE in v1. Reserved for future "customer-visible reply notes" feature. Use kind=note for internal only.';

CREATE INDEX IF NOT EXISTS idx_support_notes_conv
    ON support_notes(conversation_id, created_at DESC);

-- ─── 5. conversation_tags ──────────────────────────────────────────────────
-- Free-form tags for filtering. Many-to-many: one conversation can have
-- many tags (refund, fake_claim, repeat_customer, vip, etc.).

CREATE TABLE IF NOT EXISTS conversation_tags (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,
    added_by        TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(conversation_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_conv_tags_tag
    ON conversation_tags(tag);
CREATE INDEX IF NOT EXISTS idx_conv_tags_conv
    ON conversation_tags(conversation_id);

-- ─── 6. Performance index for the sidebar list ─────────────────────────────

CREATE INDEX IF NOT EXISTS idx_conversations_priority_activity
    ON conversations(priority, last_message_at DESC NULLS LAST)
    WHERE status IN ('open','escalated');

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_open
    ON conversations(assigned_to, last_message_at DESC)
    WHERE status IN ('open','escalated');

-- ─── 7. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE support_agents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_notes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_tags          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_agents_select ON support_agents;
CREATE POLICY support_agents_select ON support_agents FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS support_agents_write ON support_agents;
CREATE POLICY support_agents_write ON support_agents FOR ALL
    USING (current_user_role() IN ('owner'))
    WITH CHECK (current_user_role() IN ('owner'));

DROP POLICY IF EXISTS conv_assign_select ON conversation_assignments;
CREATE POLICY conv_assign_select ON conversation_assignments FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS conv_assign_write ON conversation_assignments;
CREATE POLICY conv_assign_write ON conversation_assignments FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

DROP POLICY IF EXISTS support_notes_select ON support_notes;
CREATE POLICY support_notes_select ON support_notes FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS support_notes_write ON support_notes;
CREATE POLICY support_notes_write ON support_notes FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

DROP POLICY IF EXISTS conv_tags_select ON conversation_tags;
CREATE POLICY conv_tags_select ON conversation_tags FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS conv_tags_write ON conversation_tags;
CREATE POLICY conv_tags_write ON conversation_tags FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

-- ─── 8. Bootstrap: seed owner as first support agent ────────────────────────

INSERT INTO support_agents (user_id, email, display_name, role)
SELECT u.id, u.email, COALESCE(p.full_name, u.email), 'admin'
  FROM auth.users u
  LEFT JOIN user_profiles p ON p.id = u.id
 WHERE p.role = 'owner'
ON CONFLICT (email) DO NOTHING;

-- ─── 9. Force PostgREST refresh ─────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ─── Verify ────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='conversations'
--    AND column_name IN ('ai_enabled','priority','assigned_to','resolved_at','last_read_at','internal_tags');
-- -- expect 6 rows
--
-- SELECT count(*) FROM support_agents;
-- -- expect 1 (the owner)
