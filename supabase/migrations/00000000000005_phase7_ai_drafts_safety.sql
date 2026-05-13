-- ============================================================================
-- PHASE 7 — AI drafts safety net
-- ============================================================================
-- If a product insert from Bulk AI fails (RLS, schema cache, FK violation,
-- whatever), the AI output is NEVER lost. It lands in ai_drafts instead.
-- An owner can then recover it from the review screen.
--
-- Also re-runs the AI column adds from 0004 idempotently — so if 0004 was
-- skipped on prod, this migration unblocks the pipeline on its own.
--
-- Always ends with NOTIFY pgrst, 'reload schema' so PostgREST picks up new
-- columns immediately (Supabase auto-reloads but it can lag by 60s).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Belt-and-braces: re-add the AI columns from migration 0004
--    (some prod environments missed that migration — this guarantees they exist)
-- ----------------------------------------------------------------------------

ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_generated  BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(3,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_meta       JSONB;

-- Also re-seed the Unknown brand fallback in case 0004 was skipped
INSERT INTO brands (name, name_ar, code, country_origin) VALUES
    ('Unknown', 'غير محدد', 'UNK', 'Unknown')
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. ai_drafts — safety net table
-- ----------------------------------------------------------------------------
-- When products INSERT fails, the entire AI payload + error context goes here.
-- The recovery flow can later transform an ai_draft → a real product.
--
-- Status lifecycle:
--   pending_recovery   just landed here after a failed product insert
--   recovered          owner converted it into a real product (recovered_master_sku set)
--   dismissed          owner explicitly dropped it (junk image, duplicate, etc.)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_drafts (
    id                    BIGSERIAL PRIMARY KEY,
    image_url             TEXT NOT NULL,
    original_filename     TEXT,
    suggestion            JSONB NOT NULL,        -- raw Claude output (bilingual Malika block)
    confidence            NUMERIC(3,2),
    ai_meta               JSONB,                 -- model, tokens, cost, latency, fallback_used
    status                TEXT NOT NULL DEFAULT 'pending_recovery'
                          CHECK (status IN ('pending_recovery','recovered','dismissed')),
    error_code            TEXT,                  -- e.g. 'SCHEMA_CACHE', 'INSERT_FAILED'
    error_message         TEXT,                  -- raw db error
    failing_table         TEXT,                  -- products | product_images | ...
    failing_payload       JSONB,                 -- the rejected insert payload (snapshot)
    created_by            TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    recovered_at          TIMESTAMPTZ,
    recovered_master_sku  TEXT REFERENCES products(master_sku) ON DELETE SET NULL
);

COMMENT ON TABLE ai_drafts IS
    'Safety table for Bulk AI: stores AI output when product insert fails so nothing is lost. Owner recovers from review screen.';

CREATE INDEX IF NOT EXISTS idx_ai_drafts_status   ON ai_drafts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_drafts_filename ON ai_drafts(original_filename);
CREATE INDEX IF NOT EXISTS idx_ai_drafts_pending  ON ai_drafts(created_at DESC) WHERE status = 'pending_recovery';

-- ----------------------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------------------

ALTER TABLE ai_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_drafts_select ON ai_drafts;
CREATE POLICY ai_drafts_select ON ai_drafts FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS ai_drafts_insert ON ai_drafts;
CREATE POLICY ai_drafts_insert ON ai_drafts FOR INSERT
    WITH CHECK (current_user_role() IN ('owner','editor'));

DROP POLICY IF EXISTS ai_drafts_update ON ai_drafts;
CREATE POLICY ai_drafts_update ON ai_drafts FOR UPDATE
    USING (current_user_role() IN ('owner','editor'));

DROP POLICY IF EXISTS ai_drafts_delete ON ai_drafts;
CREATE POLICY ai_drafts_delete ON ai_drafts FOR DELETE
    USING (current_user_role() = 'owner');

-- ----------------------------------------------------------------------------
-- 4. Force PostgREST schema reload — fixes "schema cache" errors after migrate
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 5. Verify
-- ----------------------------------------------------------------------------
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'products'
--      AND column_name IN ('ai_generated','ai_confidence','ai_meta');
--   SELECT id, name FROM brands WHERE name = 'Unknown';
--   SELECT count(*) FROM ai_drafts;
