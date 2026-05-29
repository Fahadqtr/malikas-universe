-- ============================================================================
-- MIGRATION 0022 — Phase 13F: Snoonu xlsx export Fast Sync
-- ============================================================================
-- The Snoonu Seller Portal lets us download an xlsx export containing
-- authoritative product data for all 1144 listings in one file:
--   - SPI (Snoonu's stable unique identifier)
--   - EN/AR name and description
--   - Per-branch price, stock, and availability (2 branches)
--   - SKU + barcode (when present)
--
-- The export does NOT include catalog, image, or category. Those still come
-- from the category-page scraper (Phase 13F.5) or the browser audit
-- (Phase 13E).
--
-- This migration adds the columns we need to round-trip the export.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. platform_products — per-branch + SPI columns ───────────────────────
ALTER TABLE platform_products
    ADD COLUMN IF NOT EXISTS snoonu_spi                            TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_export_row                     INTEGER,
    ADD COLUMN IF NOT EXISTS snoonu_export_synced_at               TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS snoonu_price_ali_bin_abdullah         NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS snoonu_price_al_aziziyah              NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS snoonu_stock_ali_bin_abdullah         INTEGER,
    ADD COLUMN IF NOT EXISTS snoonu_stock_al_aziziyah              INTEGER,
    ADD COLUMN IF NOT EXISTS snoonu_availability_ali_bin_abdullah  BOOLEAN,
    ADD COLUMN IF NOT EXISTS snoonu_availability_al_aziziyah       BOOLEAN;

COMMENT ON COLUMN platform_products.snoonu_spi IS
  'Phase 13F: Snoonu Stable Product Identifier (SPI) — the platform''s own immutable ID. 1:1 with a Snoonu listing.';
COMMENT ON COLUMN platform_products.snoonu_export_row IS
  'Phase 13F: 1-based row index in the source xlsx — used for debugging which row updated this product.';
COMMENT ON COLUMN platform_products.snoonu_export_synced_at IS
  'Phase 13F: timestamp of the most recent Fast Sync import that touched this row.';
COMMENT ON COLUMN platform_products.snoonu_price_ali_bin_abdullah IS
  'Phase 13F: per-branch price captured from Snoonu xlsx — Ali Bin Abdullah Street branch.';
COMMENT ON COLUMN platform_products.snoonu_price_al_aziziyah IS
  'Phase 13F: per-branch price captured from Snoonu xlsx — Al Aziziyah branch.';
COMMENT ON COLUMN platform_products.snoonu_stock_ali_bin_abdullah IS
  'Phase 13F: per-branch stock from Snoonu xlsx — Ali Bin Abdullah Street branch.';
COMMENT ON COLUMN platform_products.snoonu_stock_al_aziziyah IS
  'Phase 13F: per-branch stock from Snoonu xlsx — Al Aziziyah branch.';
COMMENT ON COLUMN platform_products.snoonu_availability_ali_bin_abdullah IS
  'Phase 13F: per-branch availability flag from Snoonu xlsx — Ali Bin Abdullah Street branch.';
COMMENT ON COLUMN platform_products.snoonu_availability_al_aziziyah IS
  'Phase 13F: per-branch availability flag from Snoonu xlsx — Al Aziziyah branch.';

-- ─── 2. Indexes for fast lookups during import ─────────────────────────────
-- Make SPI unique within the Snoonu platform — one product per SPI.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pp_snoonu_spi
    ON platform_products (platform, snoonu_spi)
    WHERE snoonu_spi IS NOT NULL;

-- General lookup index for the importer.
CREATE INDEX IF NOT EXISTS idx_pp_snoonu_spi
    ON platform_products (snoonu_spi)
    WHERE snoonu_spi IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pp_snoonu_export_synced_at
    ON platform_products (snoonu_export_synced_at DESC)
    WHERE snoonu_export_synced_at IS NOT NULL;

-- ─── 3. snoonu_browser_audits — link audits back to SPI ────────────────────
ALTER TABLE snoonu_browser_audits
    ADD COLUMN IF NOT EXISTS snoonu_spi TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_snoonu_spi
    ON snoonu_browser_audits (snoonu_spi)
    WHERE snoonu_spi IS NOT NULL;

COMMENT ON COLUMN snoonu_browser_audits.snoonu_spi IS
  'Phase 13F: SPI populated from the xlsx import — lets us re-find audited products after re-import.';

-- ─── 4. Fast-Sync log table (per import run) ───────────────────────────────
-- Different from platform_imports because Fast Sync UPSERTS into existing
-- platform_products instead of creating one row per row in the file.
CREATE TABLE IF NOT EXISTS snoonu_fast_sync_runs (
    id                      BIGSERIAL PRIMARY KEY,
    import_id               BIGINT REFERENCES platform_imports(id) ON DELETE SET NULL,
    source_filename         TEXT,
    total_rows              INTEGER NOT NULL DEFAULT 0,
    inserted_rows           INTEGER NOT NULL DEFAULT 0,
    updated_rows            INTEGER NOT NULL DEFAULT 0,
    unchanged_rows          INTEGER NOT NULL DEFAULT 0,
    skipped_rows            INTEGER NOT NULL DEFAULT 0,
    missing_spi             INTEGER NOT NULL DEFAULT 0,
    missing_name            INTEGER NOT NULL DEFAULT 0,
    prices_captured         INTEGER NOT NULL DEFAULT 0,
    stocks_captured         INTEGER NOT NULL DEFAULT 0,
    availability_captured   INTEGER NOT NULL DEFAULT 0,
    branch_data_coverage    NUMERIC(4,1),  -- percentage 0.0–100.0
    status                  TEXT NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'error')),
    error_message           TEXT,
    sample_changes          JSONB DEFAULT '[]'::jsonb,
    started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fast_sync_runs_started
    ON snoonu_fast_sync_runs (started_at DESC);

COMMENT ON TABLE snoonu_fast_sync_runs IS
  'Phase 13F: one row per Fast Sync xlsx import. Tracks counts + sample changes for audit trail.';

-- ─── 5. Convenience view — most recent Fast Sync per product ───────────────
DROP VIEW IF EXISTS v_snoonu_fast_sync_coverage;
CREATE VIEW v_snoonu_fast_sync_coverage AS
SELECT
    COUNT(*)                                                       AS total_snoonu_products,
    COUNT(*) FILTER (WHERE snoonu_spi IS NOT NULL)                 AS with_spi,
    COUNT(*) FILTER (WHERE snoonu_export_synced_at IS NOT NULL)    AS export_synced,
    COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(snoonu_branches, '[]'::jsonb)) = 2) AS both_branches,
    COUNT(*) FILTER (WHERE snoonu_category IS NOT NULL)            AS has_category,
    COUNT(*) FILTER (WHERE image_url IS NOT NULL AND image_url != '') AS has_image,
    COUNT(*) FILTER (WHERE source_sku IS NOT NULL AND source_sku != '') AS has_sku,
    COUNT(*) FILTER (WHERE barcode IS NOT NULL AND barcode != '')  AS has_barcode,
    MAX(snoonu_export_synced_at)                                   AS last_sync_at
FROM platform_products
WHERE platform = 'snoonu';

COMMENT ON VIEW v_snoonu_fast_sync_coverage IS
  'Phase 13F: at-a-glance Snoonu product coverage after Fast Sync — drives the dashboard cards.';

-- ============================================================================
-- End of migration 0022
-- ============================================================================
