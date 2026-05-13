-- ============================================================================
-- PHASE 9 — Marketplace export history
-- ============================================================================
-- Tracks every export generated from the platform. Used by:
--   • /export-center "Recent exports" panel
--   • Audit log of what was sent where, by whom, when
--
-- We do NOT store the file content here. Just metadata + counts.
-- ============================================================================

CREATE TABLE IF NOT EXISTS export_history (
    id                BIGSERIAL PRIMARY KEY,
    target            TEXT NOT NULL
                      CHECK (target IN ('snoonu','talabat','rafeeq','shopify','custom')),
    format            TEXT NOT NULL
                      CHECK (format IN ('csv','xlsx')),
    filters           JSONB,                -- snapshot of filter UI state
    product_count     INTEGER NOT NULL DEFAULT 0,
    blocked_count     INTEGER NOT NULL DEFAULT 0,
    file_bytes        INTEGER,
    filename          TEXT,
    exported_by       TEXT,
    exported_at       TIMESTAMPTZ DEFAULT NOW(),
    notes             TEXT
);

COMMENT ON TABLE export_history IS
    'One row per export generated from /export-center. Tracks target, counts, who, when.';

CREATE INDEX IF NOT EXISTS idx_export_history_target_time
    ON export_history(target, exported_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_history_actor_time
    ON export_history(exported_by, exported_at DESC);

-- RLS
ALTER TABLE export_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_history_select ON export_history;
CREATE POLICY export_history_select ON export_history FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));

DROP POLICY IF EXISTS export_history_insert ON export_history;
CREATE POLICY export_history_insert ON export_history FOR INSERT
    WITH CHECK (current_user_role() IN ('owner','editor'));

DROP POLICY IF EXISTS export_history_delete ON export_history;
CREATE POLICY export_history_delete ON export_history FOR DELETE
    USING (current_user_role() = 'owner');

NOTIFY pgrst, 'reload schema';

-- Verify
-- SELECT count(*) FROM export_history;
