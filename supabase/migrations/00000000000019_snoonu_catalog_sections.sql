-- ============================================================================
-- MIGRATION 0019 — Phase 13D.7: Snoonu catalog sections (authoritative list)
-- ============================================================================
-- The Snoonu Seller Portal catalog overview page lists every "section" /
-- "catalog" the store is organized into, e.g.:
--   Eid Specials · Hair Care · Face Care · Sun Protection · Masks ·
--   Body Care · Dental Care · Beauty Accessories · Beauty Bundle ·
--   Makeup · Lashes & Nails · Toys · Rhode Products Section · Electronics ·
--   Women's Essentials · Gifts & Special Occasions · Thailand Products ...
--
-- We capture these once (read-only) and use them as the source of truth when
-- mapping each platform_products row to a Snoonu section.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. snoonu_catalog_sections table ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS snoonu_catalog_sections (
    id                  BIGSERIAL PRIMARY KEY,
    catalog_name_en     TEXT NOT NULL,
    catalog_name_ar     TEXT,
    product_count       INTEGER,
    source_url          TEXT,
    scraped_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_text            TEXT,
    notes               TEXT
);

-- Dedup on (name + source_url). Two different source URLs for the same name
-- are allowed (e.g. preview vs. live portal).
CREATE UNIQUE INDEX IF NOT EXISTS uq_snoonu_section_name_url
    ON snoonu_catalog_sections (catalog_name_en, COALESCE(source_url, ''));

CREATE INDEX IF NOT EXISTS idx_snoonu_section_scraped_at
    ON snoonu_catalog_sections (scraped_at DESC);

COMMENT ON TABLE snoonu_catalog_sections IS
  'Phase 13D.7: authoritative list of Snoonu catalog sections, scraped read-only from the seller-portal catalog overview page.';

-- ─── 2. Extend platform_products.catalog_source CHECK ──────────────────────

ALTER TABLE platform_products
    DROP CONSTRAINT IF EXISTS platform_products_catalog_source_check;

ALTER TABLE platform_products
    ADD CONSTRAINT platform_products_catalog_source_check
    CHECK (catalog_source IS NULL OR catalog_source IN (
        'export_column',
        'manual_paste',
        'browser_read',
        'inferred',
        'catalog_section_match'   -- Phase 13D.7
    ));

COMMENT ON CONSTRAINT platform_products_catalog_source_check ON platform_products IS
  'Phase 13D.7: catalog_section_match means we matched the product to a known section in snoonu_catalog_sections';

-- ─── 3. Refresh summary view (uses extended catalog_source values) ─────────

DROP VIEW IF EXISTS v_snoonu_catalog_mapping_summary;
CREATE VIEW v_snoonu_catalog_mapping_summary AS
SELECT
    p.import_id,
    p.platform,
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (WHERE p.snoonu_category IS NOT NULL) AS mapped,
    COUNT(*) FILTER (WHERE p.snoonu_category IS NULL)     AS missing,
    COUNT(*) FILTER (WHERE p.catalog_source = 'export_column')         AS via_export,
    COUNT(*) FILTER (WHERE p.catalog_source = 'manual_paste')          AS via_paste,
    COUNT(*) FILTER (WHERE p.catalog_source = 'browser_read')          AS via_browser,
    COUNT(*) FILTER (WHERE p.catalog_source = 'inferred')              AS via_inferred,
    COUNT(*) FILTER (WHERE p.catalog_source = 'catalog_section_match') AS via_section_match,
    COUNT(*) FILTER (WHERE p.catalog_confidence >= 0.85)               AS high_confidence,
    COUNT(*) FILTER (WHERE p.catalog_confidence < 0.85
                       AND p.catalog_confidence IS NOT NULL)           AS low_confidence,
    MAX(p.catalog_checked_at)                                          AS last_checked_at
FROM platform_products p
WHERE p.platform = 'snoonu'
GROUP BY p.import_id, p.platform;

COMMENT ON VIEW v_snoonu_catalog_mapping_summary IS
  'Phase 13D.7: per-import mapping progress including catalog_section_match counts and confidence buckets.';

-- ============================================================================
-- End of migration 0019
-- ============================================================================
