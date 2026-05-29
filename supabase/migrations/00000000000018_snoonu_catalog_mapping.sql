-- ============================================================================
-- MIGRATION 0018 — Phase 13D: Snoonu Catalog Mapper
-- ============================================================================
-- Captures where each product is placed inside the Snoonu catalog hierarchy,
-- so we always know "this product lives under Snoonu > Beauty > Skincare > Korean".
--
-- Strategy: extend platform_products (rather than a separate table) because
-- the mapping is per-import-row. Only Snoonu rows ever get these populated.
--
-- Fields:
--   snoonu_catalog              — top-level catalog (e.g. "Beauty", "Wellness")
--   snoonu_category             — main category (e.g. "Skincare")
--   snoonu_subcategory          — sub category (e.g. "Korean Skincare")
--   snoonu_section              — UI section (e.g. "Featured", "New Arrivals")
--   snoonu_collection           — collection if applicable
--   snoonu_menu_path            — full breadcrumb, e.g. "Beauty > Skincare > Korean"
--   snoonu_catalog_source_url   — URL where we read the catalog from
--   catalog_source              — how we got it (see CHECK below)
--   catalog_confidence          — 0.00–1.00
--   catalog_checked_at          — last verification timestamp
--
-- catalog_source values:
--   'export_column'  — pulled from a column in the seller-portal export
--   'manual_paste'   — operator pasted from a Snoonu page
--   'browser_read'   — Chrome MCP read it from product detail/edit page (READ ONLY)
--   'inferred'       — derived from product name / brand keyword rules
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE platform_products
    ADD COLUMN IF NOT EXISTS snoonu_catalog             TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_category            TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_subcategory         TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_section             TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_collection          TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_menu_path           TEXT,
    ADD COLUMN IF NOT EXISTS snoonu_catalog_source_url  TEXT,
    ADD COLUMN IF NOT EXISTS catalog_source             TEXT,
    ADD COLUMN IF NOT EXISTS catalog_confidence         NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS catalog_checked_at         TIMESTAMPTZ;

-- CHECK constraint on catalog_source
ALTER TABLE platform_products
    DROP CONSTRAINT IF EXISTS platform_products_catalog_source_check;

ALTER TABLE platform_products
    ADD CONSTRAINT platform_products_catalog_source_check
    CHECK (catalog_source IS NULL OR catalog_source IN (
        'export_column',
        'manual_paste',
        'browser_read',
        'inferred'
    ));

-- Comments
COMMENT ON COLUMN platform_products.snoonu_menu_path
    IS 'Phase 13D: full breadcrumb path inside Snoonu, e.g. "Beauty > Skincare > Korean Skincare"';
COMMENT ON COLUMN platform_products.catalog_source
    IS 'Phase 13D: how the catalog was captured — export_column | manual_paste | browser_read | inferred';
COMMENT ON COLUMN platform_products.snoonu_catalog_source_url
    IS 'Phase 13D: the Snoonu URL the catalog was read from (audit trail for browser_read entries)';

-- Indexes for diagnostics + the catalog mapper dashboard
CREATE INDEX IF NOT EXISTS idx_pp_snoonu_catalog
    ON platform_products (snoonu_catalog) WHERE snoonu_catalog IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_snoonu_category
    ON platform_products (snoonu_category) WHERE snoonu_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_catalog_source
    ON platform_products (catalog_source) WHERE catalog_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_catalog_missing
    ON platform_products (platform, import_id)
    WHERE platform = 'snoonu' AND snoonu_category IS NULL;

-- ─── Convenience view: per-import mapping summary ──────────────────────────
CREATE OR REPLACE VIEW v_snoonu_catalog_mapping_summary AS
SELECT
    p.import_id,
    p.platform,
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (WHERE p.snoonu_category IS NOT NULL) AS mapped,
    COUNT(*) FILTER (WHERE p.snoonu_category IS NULL)     AS missing,
    COUNT(*) FILTER (WHERE p.catalog_source = 'export_column')  AS via_export,
    COUNT(*) FILTER (WHERE p.catalog_source = 'manual_paste')   AS via_paste,
    COUNT(*) FILTER (WHERE p.catalog_source = 'browser_read')   AS via_browser,
    COUNT(*) FILTER (WHERE p.catalog_source = 'inferred')       AS via_inferred,
    MAX(p.catalog_checked_at)                                   AS last_checked_at
FROM platform_products p
WHERE p.platform = 'snoonu'
GROUP BY p.import_id, p.platform;

COMMENT ON VIEW v_snoonu_catalog_mapping_summary IS
  'Phase 13D: progress dashboard for /snoonu-catalog-mapper. One row per Snoonu import.';

-- ============================================================================
-- End of migration 0018
-- ============================================================================
