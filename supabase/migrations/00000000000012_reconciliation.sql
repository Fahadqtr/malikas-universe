-- ============================================================================
-- MIGRATION 0012 — Phase 13A: Marketplace Reconciliation System
-- ============================================================================
-- Snoonu is the source of truth. Every other platform (Talabat, Rafeeq,
-- Shopify, internal catalog) must match Snoonu.
--
-- Tables:
--   1. platform_imports          — one row per uploaded file (any platform)
--   2. platform_products         — normalized product rows extracted from imports
--   3. reconciliation_runs       — a comparison session between Snoonu and N platforms
--   4. reconciliation_findings   — individual discrepancies detected during a run
--
-- Finding lifecycle:
--   detected  →  reviewed (operator picked an action)
--              →  applied (action carried out, e.g. CSV exported, Shopify pushed)
--              →  dismissed (operator marked as not-a-problem)
--
-- All writes go via the service role. Authenticated users get read access.
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. platform_imports ────────────────────────────────────────────────────
-- Each row = one operator-triggered upload (CSV / XLSX / paste / URL list).
-- Same shape works for Snoonu, Talabat, Rafeeq, Shopify, and internal.

CREATE TABLE IF NOT EXISTS platform_imports (
    id                  BIGSERIAL PRIMARY KEY,
    platform            TEXT NOT NULL CHECK (platform IN ('snoonu','talabat','rafeeq','shopify','internal','other')),
    label               TEXT,
    source_mode         TEXT NOT NULL CHECK (source_mode IN ('csv_upload','xlsx_upload','paste_list','url_list','manual')),
    source_filename     TEXT,
    column_mapping      JSONB DEFAULT '{}'::jsonb,           -- which header → which canonical field
    detected_headers    TEXT[],
    total_rows          INTEGER NOT NULL DEFAULT 0,
    parsed_rows         INTEGER NOT NULL DEFAULT 0,
    matched_rows        INTEGER NOT NULL DEFAULT 0,           -- found in our `products` table
    unmatched_rows      INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','parsing','normalizing','matching','ready','error','archived')),
    error_message       TEXT,
    created_by          UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_platform_imports_platform ON platform_imports (platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_imports_status   ON platform_imports (status, created_at DESC);

COMMENT ON TABLE platform_imports IS
  'Phase 13A: One row per operator-uploaded platform export. Drives /reconciliation.';

-- ─── 2. platform_products ───────────────────────────────────────────────────
-- Normalized product rows from any platform. Compared against our master
-- `products` table via matched_master_sku.

CREATE TABLE IF NOT EXISTS platform_products (
    id                      BIGSERIAL PRIMARY KEY,
    import_id               BIGINT NOT NULL REFERENCES platform_imports(id) ON DELETE CASCADE,
    platform                TEXT NOT NULL CHECK (platform IN ('snoonu','talabat','rafeeq','shopify','internal','other')),
    source_row_index        INTEGER,                          -- which row in the source file
    source_product_id       TEXT,                             -- platform's own product ID
    source_url              TEXT,
    source_sku              TEXT,                             -- whatever SKU the platform uses
    barcode                 TEXT,

    -- Canonical fields (normalized from platform-specific columns)
    name_en                 TEXT,
    name_ar                 TEXT,
    brand                   TEXT,
    category                TEXT,
    subcategory             TEXT,
    product_type            TEXT,
    price                   NUMERIC(10,2),
    discount_price          NUMERIC(10,2),
    currency                TEXT DEFAULT 'QAR',
    stock_quantity          INTEGER,
    stock_status            TEXT,                             -- raw value, may be 'in_stock','OOS','Active', etc
    platform_status         TEXT,                             -- 'Active'/'Draft'/'Archived' on this platform
    image_url               TEXT,
    image_filename          TEXT,
    variants                JSONB DEFAULT '[]'::jsonb,        -- array of {type,value,sku,image,price,stock}
    description_en          TEXT,
    description_ar          TEXT,

    -- Match to master catalog
    matched_master_sku      TEXT REFERENCES products(master_sku) ON DELETE SET NULL,
    match_status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (match_status IN ('pending','exact','likely','possible','none','manual')),
    match_confidence        NUMERIC(3,2),
    match_signals           JSONB DEFAULT '[]'::jsonb,        -- ['sku_exact','barcode_exact','brand_name', ...]

    raw_payload             JSONB DEFAULT '{}'::jsonb,        -- the original row
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_products_import   ON platform_products (import_id);
CREATE INDEX IF NOT EXISTS idx_platform_products_platform ON platform_products (platform, matched_master_sku);
CREATE INDEX IF NOT EXISTS idx_platform_products_match    ON platform_products (matched_master_sku) WHERE matched_master_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_products_sku      ON platform_products (platform, source_sku) WHERE source_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_products_barcode  ON platform_products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_products_name_en  ON platform_products USING gin (to_tsvector('simple', coalesce(name_en, '')));

COMMENT ON TABLE platform_products IS
  'Phase 13A: Normalized product rows from any platform export. Matched against the master products table.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION touch_platform_products() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_platform_products ON platform_products;
CREATE TRIGGER trg_touch_platform_products
    BEFORE UPDATE ON platform_products
    FOR EACH ROW EXECUTE FUNCTION touch_platform_products();

-- ─── 3. reconciliation_runs ─────────────────────────────────────────────────
-- One row per comparison session.
-- baseline_platform is always Snoonu in Phase 13A; field exists so we can later
-- run e.g. Shopify-vs-Talabat comparisons without schema changes.

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id                  BIGSERIAL PRIMARY KEY,
    label               TEXT,
    baseline_platform   TEXT NOT NULL DEFAULT 'snoonu'
                        CHECK (baseline_platform IN ('snoonu','talabat','rafeeq','shopify','internal')),
    baseline_import_id  BIGINT REFERENCES platform_imports(id) ON DELETE SET NULL,
    target_platforms    TEXT[] NOT NULL,                      -- e.g. ['talabat']
    target_import_ids   BIGINT[] DEFAULT '{}',                -- aligned with target_platforms
    findings_total      INTEGER NOT NULL DEFAULT 0,
    findings_by_type    JSONB DEFAULT '{}'::jsonb,            -- {price_mismatch:12, missing_on_target:8}
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','completed','error','cancelled')),
    error_message       TEXT,
    created_by          UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_status ON reconciliation_runs (status, created_at DESC);

COMMENT ON TABLE reconciliation_runs IS
  'Phase 13A: One comparison session. Baseline (Snoonu) vs one or more target platforms.';

-- ─── 4. reconciliation_findings ─────────────────────────────────────────────
-- One row per discrepancy. The UI groups these by finding_type into tabs.

CREATE TABLE IF NOT EXISTS reconciliation_findings (
    id                          BIGSERIAL PRIMARY KEY,
    run_id                      BIGINT NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
    master_sku                  TEXT,                              -- our SKU if matched
    baseline_platform           TEXT NOT NULL DEFAULT 'snoonu',
    baseline_product_id         BIGINT REFERENCES platform_products(id) ON DELETE SET NULL,
    target_platform             TEXT NOT NULL,
    target_product_id           BIGINT REFERENCES platform_products(id) ON DELETE SET NULL,

    finding_type                TEXT NOT NULL CHECK (finding_type IN (
                                    'missing_on_target',          -- in Snoonu, not in target
                                    'missing_on_baseline',        -- in target, not in Snoonu
                                    'price_mismatch',
                                    'discount_mismatch',
                                    'name_en_mismatch',
                                    'name_ar_mismatch',
                                    'brand_mismatch',
                                    'category_mismatch',
                                    'image_mismatch',
                                    'stock_mismatch',
                                    'status_mismatch',
                                    'variant_mismatch',
                                    'barcode_mismatch',
                                    'duplicate_on_target'
                                )),
    severity                    TEXT NOT NULL DEFAULT 'medium'
                                CHECK (severity IN ('low','medium','high','critical')),
    baseline_value              TEXT,                              -- Snoonu's value
    target_value                TEXT,                              -- platform's value
    diff_meta                   JSONB DEFAULT '{}'::jsonb,         -- e.g. {pct_diff:0.15}

    suggested_action            TEXT CHECK (suggested_action IN (
                                    'add_to_target',
                                    'remove_from_target',
                                    'update_target_price',
                                    'update_target_name',
                                    'update_target_category',
                                    'use_snoonu_image',
                                    'mark_oos_on_target',
                                    'activate_on_target',
                                    'deactivate_on_target',
                                    'resolve_variant',
                                    'review_manually',
                                    'none'
                                ) OR suggested_action IS NULL),

    resolution_status           TEXT NOT NULL DEFAULT 'pending'
                                CHECK (resolution_status IN ('pending','reviewed','applied','dismissed')),
    resolution_notes            TEXT,
    resolved_by                 UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    resolved_at                 TIMESTAMPTZ,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_findings_run         ON reconciliation_findings (run_id, finding_type);
CREATE INDEX IF NOT EXISTS idx_findings_type        ON reconciliation_findings (finding_type, severity);
CREATE INDEX IF NOT EXISTS idx_findings_resolution  ON reconciliation_findings (resolution_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_master_sku  ON reconciliation_findings (master_sku) WHERE master_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_target      ON reconciliation_findings (target_platform, finding_type);

COMMENT ON TABLE reconciliation_findings IS
  'Phase 13A: Every detected discrepancy between Snoonu (baseline) and a target platform.';

-- ─── 5. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE platform_imports         ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_findings  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_imports' AND policyname='auth_read_pimports') THEN
        CREATE POLICY auth_read_pimports ON platform_imports FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='platform_products' AND policyname='auth_read_pproducts') THEN
        CREATE POLICY auth_read_pproducts ON platform_products FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='reconciliation_runs' AND policyname='auth_read_runs') THEN
        CREATE POLICY auth_read_runs ON reconciliation_runs FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='reconciliation_findings' AND policyname='auth_read_findings') THEN
        CREATE POLICY auth_read_findings ON reconciliation_findings FOR SELECT TO authenticated USING (true);
    END IF;
END $$;

-- ─── 6. Convenience view: latest finding counts per platform pair ──────────
CREATE OR REPLACE VIEW v_reconciliation_finding_summary AS
SELECT
    run_id,
    target_platform,
    finding_type,
    severity,
    COUNT(*) AS n,
    COUNT(*) FILTER (WHERE resolution_status = 'pending') AS pending,
    COUNT(*) FILTER (WHERE resolution_status = 'applied') AS applied
FROM reconciliation_findings
GROUP BY run_id, target_platform, finding_type, severity;

COMMENT ON VIEW v_reconciliation_finding_summary IS
  'Group findings by run × target × type × severity. Used by /reconciliation dashboard tabs.';
