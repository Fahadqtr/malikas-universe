-- ============================================================================
-- MIGRATION 0020 — Phase 13E: Snoonu Browser Product Auditor
-- ============================================================================
-- READ-ONLY captures of Snoonu product detail pages. Each row holds the
-- exact data the operator (or Chrome MCP) read from a Snoonu product page,
-- without ever writing back to Snoonu.
--
-- Workflow:
--   1. Operator opens a Snoonu product page in Chrome
--   2. Operator triggers "Read snapshot" — Chrome MCP extracts DOM/text
--   3. Snapshot is saved here with audit_status='audited'
--   4. Operator clicks "Apply" — selected fields are copied to platform_products
--   5. Catalog/price/stock/variants in our system now match Snoonu exactly
--
-- audit_status lifecycle:
--   pending   — queued for audit (auto-created when conditions are met)
--   audited   — browser snapshot saved, awaiting operator review
--   verified  — operator reviewed and confirmed the snapshot is correct
--   applied   — snapshot fields were copied to platform_products
--   skipped   — operator decided this product doesn't need an audit
--   error     — snapshot parsing or apply failed
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. Main audit table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS snoonu_browser_audits (
    id                        BIGSERIAL PRIMARY KEY,
    product_id                BIGINT NOT NULL REFERENCES platform_products(id) ON DELETE CASCADE,
    import_id                 BIGINT REFERENCES platform_imports(id) ON DELETE SET NULL,

    -- Snoonu identifiers
    snoonu_product_url        TEXT,
    snoonu_product_id         TEXT,                -- SPI / Snoonu Product Identifier
    snoonu_product_name       TEXT,
    snoonu_name_ar            TEXT,

    -- Catalog hierarchy (mirrors Snoonu UI)
    snoonu_catalog            TEXT,
    snoonu_category           TEXT,
    snoonu_subcategory        TEXT,
    snoonu_section            TEXT,
    snoonu_menu_path          TEXT,

    -- Pricing
    snoonu_price              NUMERIC(10,2),
    snoonu_discount_price     NUMERIC(10,2),
    snoonu_currency           TEXT DEFAULT 'QAR',

    -- Inventory & visibility
    snoonu_stock              INTEGER,
    snoonu_status             TEXT,                -- active / inactive / paused etc.
    snoonu_is_visible         BOOLEAN,

    -- Image
    snoonu_image_url          TEXT,
    snoonu_image_filename     TEXT,

    -- Options & variants
    has_options               BOOLEAN NOT NULL DEFAULT FALSE,
    option_groups             JSONB DEFAULT '[]'::jsonb,
    variants                  JSONB DEFAULT '[]'::jsonb,

    -- Raw blob (full DOM/text extract, for debugging or re-parsing)
    raw_browser_snapshot      JSONB,

    -- Audit metadata
    audit_status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (audit_status IN (
                                  'pending', 'audited', 'verified', 'applied', 'skipped', 'error'
                              )),
    audit_confidence          NUMERIC(3,2),
    audit_reason              TEXT,                -- why this product was queued
    audit_priority            INTEGER NOT NULL DEFAULT 50,  -- lower = more urgent
    audit_notes               TEXT,
    audit_error_message       TEXT,

    audited_at                TIMESTAMPTZ,
    audited_by                UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    verified_at               TIMESTAMPTZ,
    verified_by               UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    applied_at                TIMESTAMPTZ,
    applied_fields            TEXT[],              -- which fields were copied to platform_products

    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One audit per (product, snoonu_product_url) — operator can re-audit if URL changes
    UNIQUE (product_id, snoonu_product_url)
);

COMMENT ON TABLE snoonu_browser_audits IS
  'Phase 13E: READ-ONLY captures of Snoonu product detail pages. Drives /snoonu-browser-audit.';
COMMENT ON COLUMN snoonu_browser_audits.option_groups IS
  'JSONB array: [{name, name_ar?, required, min_select, max_select, values: [{value, value_ar?, price_impact, stock?, is_default?, is_active}]}]';
COMMENT ON COLUMN snoonu_browser_audits.variants IS
  'JSONB array: [{variant_id?, name, price?, stock?, is_active?, options: {color, size, ...}}]';
COMMENT ON COLUMN snoonu_browser_audits.audit_priority IS
  'Lower = more urgent. 10=missing catalog, 20=low confidence, 30=possible_match, 40=price_mismatch, 50=default, 60=options check';

-- ─── 2. Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_audit_product       ON snoonu_browser_audits (product_id);
CREATE INDEX IF NOT EXISTS idx_audit_status        ON snoonu_browser_audits (audit_status, audit_priority);
CREATE INDEX IF NOT EXISTS idx_audit_import        ON snoonu_browser_audits (import_id);
CREATE INDEX IF NOT EXISTS idx_audit_has_options   ON snoonu_browser_audits (has_options) WHERE has_options = TRUE;
CREATE INDEX IF NOT EXISTS idx_audit_snoonu_url    ON snoonu_browser_audits (snoonu_product_url) WHERE snoonu_product_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_pending       ON snoonu_browser_audits (audit_priority, created_at) WHERE audit_status = 'pending';

-- ─── 3. updated_at trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_snoonu_browser_audits() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_snoonu_browser_audits ON snoonu_browser_audits;
CREATE TRIGGER trg_touch_snoonu_browser_audits
    BEFORE UPDATE ON snoonu_browser_audits
    FOR EACH ROW EXECUTE FUNCTION touch_snoonu_browser_audits();

-- ─── 4. RLS ────────────────────────────────────────────────────────────────
ALTER TABLE snoonu_browser_audits ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public'
          AND tablename='snoonu_browser_audits'
          AND policyname='auth_read_browser_audits'
    ) THEN
        CREATE POLICY auth_read_browser_audits
            ON snoonu_browser_audits
            FOR SELECT TO authenticated USING (true);
    END IF;
END $$;

-- ─── 5. Progress view ──────────────────────────────────────────────────────

CREATE OR REPLACE VIEW v_snoonu_browser_audit_progress AS
SELECT
    a.import_id,
    COUNT(*) AS total_audited,
    COUNT(*) FILTER (WHERE a.audit_status = 'pending')   AS pending,
    COUNT(*) FILTER (WHERE a.audit_status = 'audited')   AS audited,
    COUNT(*) FILTER (WHERE a.audit_status = 'verified')  AS verified,
    COUNT(*) FILTER (WHERE a.audit_status = 'applied')   AS applied,
    COUNT(*) FILTER (WHERE a.audit_status = 'skipped')   AS skipped,
    COUNT(*) FILTER (WHERE a.audit_status = 'error')     AS errored,
    COUNT(*) FILTER (WHERE a.has_options = TRUE)         AS options_detected,
    COUNT(*) FILTER (WHERE a.snoonu_catalog IS NOT NULL) AS catalog_fixed,
    COUNT(*) FILTER (WHERE a.snoonu_price IS NOT NULL)   AS price_captured,
    MAX(a.audited_at) AS last_audited_at,
    MAX(a.applied_at) AS last_applied_at
FROM snoonu_browser_audits a
GROUP BY a.import_id;

COMMENT ON VIEW v_snoonu_browser_audit_progress IS
  'Phase 13E: per-import dashboard of browser audit progress.';

-- ─── 6. Helper: enqueue products that need an audit ─────────────────────────
-- A function we can call to populate the audit queue based on the rules:
--   * missing snoonu_catalog
--   * low catalog_confidence
--   * findings of type possible_match / price_mismatch / variant_missing_on_*
--   * products where Snoonu has options/variants
--
-- Inserts pending audit rows for any qualifying product that doesn't already
-- have an active audit. Returns the number of new rows queued.

CREATE OR REPLACE FUNCTION enqueue_snoonu_audits(
    p_import_id BIGINT,
    p_limit INTEGER DEFAULT 1000
) RETURNS INTEGER AS $$
DECLARE
    queued_count INTEGER := 0;
BEGIN
    -- Priority 10: Missing snoonu_catalog
    INSERT INTO snoonu_browser_audits (product_id, import_id, audit_status, audit_priority, audit_reason)
    SELECT pp.id, p_import_id, 'pending', 10, 'missing_snoonu_catalog'
    FROM platform_products pp
    WHERE pp.platform = 'snoonu'
      AND pp.import_id = p_import_id
      AND pp.snoonu_category IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM snoonu_browser_audits a
          WHERE a.product_id = pp.id
            AND a.audit_status NOT IN ('skipped', 'error')
      )
    LIMIT p_limit;
    GET DIAGNOSTICS queued_count = ROW_COUNT;

    -- Priority 20: Low catalog confidence
    INSERT INTO snoonu_browser_audits (product_id, import_id, audit_status, audit_priority, audit_reason)
    SELECT pp.id, p_import_id, 'pending', 20, 'low_catalog_confidence'
    FROM platform_products pp
    WHERE pp.platform = 'snoonu'
      AND pp.import_id = p_import_id
      AND pp.snoonu_category IS NOT NULL
      AND pp.catalog_confidence < 0.85
      AND NOT EXISTS (
          SELECT 1 FROM snoonu_browser_audits a
          WHERE a.product_id = pp.id
            AND a.audit_status NOT IN ('skipped', 'error')
      )
    LIMIT p_limit;

    -- Priority 30: possible_match findings — Snoonu side
    INSERT INTO snoonu_browser_audits (product_id, import_id, audit_status, audit_priority, audit_reason)
    SELECT DISTINCT pp.id, p_import_id, 'pending', 30, 'possible_match_finding'
    FROM platform_products pp
    JOIN reconciliation_findings f ON f.baseline_product_id = pp.id
    WHERE pp.platform = 'snoonu'
      AND pp.import_id = p_import_id
      AND f.finding_type = 'possible_match'
      AND f.resolution_status = 'pending'
      AND NOT EXISTS (
          SELECT 1 FROM snoonu_browser_audits a
          WHERE a.product_id = pp.id
            AND a.audit_status NOT IN ('skipped', 'error')
      )
    LIMIT p_limit;

    -- Priority 40: price_mismatch findings
    INSERT INTO snoonu_browser_audits (product_id, import_id, audit_status, audit_priority, audit_reason)
    SELECT DISTINCT pp.id, p_import_id, 'pending', 40, 'price_mismatch_finding'
    FROM platform_products pp
    JOIN reconciliation_findings f ON f.baseline_product_id = pp.id
    WHERE pp.platform = 'snoonu'
      AND pp.import_id = p_import_id
      AND f.finding_type = 'price_mismatch'
      AND f.resolution_status = 'pending'
      AND NOT EXISTS (
          SELECT 1 FROM snoonu_browser_audits a
          WHERE a.product_id = pp.id
            AND a.audit_status NOT IN ('skipped', 'error')
      )
    LIMIT p_limit;

    -- Priority 50: variant_missing_on_target findings
    INSERT INTO snoonu_browser_audits (product_id, import_id, audit_status, audit_priority, audit_reason)
    SELECT DISTINCT pp.id, p_import_id, 'pending', 50, 'variant_issue_finding'
    FROM platform_products pp
    JOIN reconciliation_findings f ON f.baseline_product_id = pp.id
    WHERE pp.platform = 'snoonu'
      AND pp.import_id = p_import_id
      AND f.finding_type IN ('variant_missing_on_target', 'variant_missing_on_baseline')
      AND f.resolution_status = 'pending'
      AND NOT EXISTS (
          SELECT 1 FROM snoonu_browser_audits a
          WHERE a.product_id = pp.id
            AND a.audit_status NOT IN ('skipped', 'error')
      )
    LIMIT p_limit;

    -- Final count of newly-queued (across all priority passes) — re-query
    SELECT COUNT(*) INTO queued_count
    FROM snoonu_browser_audits a
    WHERE a.import_id = p_import_id
      AND a.audit_status = 'pending'
      AND a.created_at >= NOW() - INTERVAL '5 minutes';

    RETURN queued_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enqueue_snoonu_audits IS
  'Phase 13E: populates the audit queue for an import based on missing catalog, low confidence, and unresolved findings.';

-- ============================================================================
-- End of migration 0020
-- ============================================================================
