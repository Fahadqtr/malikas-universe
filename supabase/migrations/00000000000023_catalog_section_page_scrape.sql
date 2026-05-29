-- ============================================================================
-- MIGRATION 0023 — Phase 13F.5: Catalog Section Page Scraper
-- ============================================================================
-- Captures the live Snoonu Seller Portal catalog section pages READ-ONLY.
-- For each section we record every product visible in that section, then
-- apply the mapping to platform_products:
--   - first section → snoonu_category (primary)
--   - any additional → snoonu_secondary_categories[]
--
-- New artifacts:
--   1. catalog_source value 'catalog_section_page'
--   2. snoonu_section_scrapes   — one row per scrape run per section
--   3. snoonu_section_product_links — every (section, product) link for audit trail
--      (allows multi-section + duplicate detection)
--
-- READ-ONLY against Snoonu (this migration just stores what the scraper finds).
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. Extend catalog_source CHECK ───────────────────────────────────────
ALTER TABLE platform_products
    DROP CONSTRAINT IF EXISTS platform_products_catalog_source_check;

ALTER TABLE platform_products
    ADD CONSTRAINT platform_products_catalog_source_check
    CHECK (catalog_source IS NULL OR catalog_source IN (
        'export_column',
        'manual_paste',
        'browser_read',
        'inferred',
        'catalog_section_match',
        'catalog_section_page'   -- Phase 13F.5
    ));

COMMENT ON CONSTRAINT platform_products_catalog_source_check ON platform_products IS
  'Phase 13F.5: catalog_section_page means we scraped the live Snoonu catalog section page and saw the product listed there.';

-- ─── 2. snoonu_section_scrapes — one row per scrape run ───────────────────
CREATE TABLE IF NOT EXISTS snoonu_section_scrapes (
    id                  BIGSERIAL PRIMARY KEY,
    section_name        TEXT NOT NULL,
    source_url          TEXT,
    pages_scanned       INTEGER NOT NULL DEFAULT 1,
    products_found      INTEGER NOT NULL DEFAULT 0,
    products_matched    INTEGER NOT NULL DEFAULT 0,
    products_unmatched  INTEGER NOT NULL DEFAULT 0,
    duplicates_in_section INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'completed'
                        CHECK (status IN ('running', 'completed', 'error')),
    error_message       TEXT,
    sample_unmatched    JSONB DEFAULT '[]'::jsonb,
    raw_payload         JSONB,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_section_scrapes_section
    ON snoonu_section_scrapes (section_name, started_at DESC);

COMMENT ON TABLE snoonu_section_scrapes IS
  'Phase 13F.5: one row per Snoonu catalog section page scrape run. Tracks coverage + unmatched names.';

-- ─── 3. snoonu_section_product_links — section ↔ product audit trail ──────
CREATE TABLE IF NOT EXISTS snoonu_section_product_links (
    id                  BIGSERIAL PRIMARY KEY,
    scrape_id           BIGINT NOT NULL REFERENCES snoonu_section_scrapes(id) ON DELETE CASCADE,
    section_name        TEXT NOT NULL,
    product_id          BIGINT REFERENCES platform_products(id) ON DELETE SET NULL,
    scraped_spi         TEXT,
    scraped_name        TEXT NOT NULL,
    scraped_price       NUMERIC(10,2),
    scraped_image_url   TEXT,
    match_method        TEXT NOT NULL
                        CHECK (match_method IN ('spi', 'normalized_name', 'fuzzy_name', 'no_match')),
    match_confidence    NUMERIC(3,2),
    is_primary_section  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_section_links_product
    ON snoonu_section_product_links (product_id) WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_section_links_section
    ON snoonu_section_product_links (section_name);

CREATE INDEX IF NOT EXISTS idx_section_links_unmatched
    ON snoonu_section_product_links (section_name)
    WHERE product_id IS NULL;

COMMENT ON TABLE snoonu_section_product_links IS
  'Phase 13F.5: every (section, product) pair observed during a section scrape. One product may appear in multiple sections (multi-category).';

-- ─── 4. Helper view: catalog coverage by section ──────────────────────────
DROP VIEW IF EXISTS v_snoonu_section_coverage;
CREATE VIEW v_snoonu_section_coverage AS
SELECT
    s.section_name,
    s.products_found,
    s.products_matched,
    s.products_unmatched,
    s.duplicates_in_section,
    s.started_at AS last_scraped_at,
    s.status,
    s.id AS last_scrape_id
FROM snoonu_section_scrapes s
WHERE s.id IN (
    SELECT MAX(id) FROM snoonu_section_scrapes GROUP BY section_name
)
ORDER BY s.section_name;

COMMENT ON VIEW v_snoonu_section_coverage IS
  'Phase 13F.5: per-section status (last scrape only). Drives the Fast Sync UI section grid.';

-- ─── 5. Helper view: overall mapping coverage ─────────────────────────────
DROP VIEW IF EXISTS v_snoonu_catalog_coverage;
CREATE VIEW v_snoonu_catalog_coverage AS
SELECT
    COUNT(*)                                                          AS total_snoonu_products,
    COUNT(*) FILTER (WHERE snoonu_category IS NOT NULL)               AS with_category,
    COUNT(*) FILTER (WHERE snoonu_category IS NULL)                   AS missing_category,
    COUNT(*) FILTER (WHERE array_length(snoonu_secondary_categories, 1) > 0) AS multi_category,
    COUNT(*) FILTER (WHERE catalog_source = 'catalog_section_page')   AS via_section_page,
    COUNT(*) FILTER (WHERE catalog_source = 'browser_read')           AS via_browser_audit,
    COUNT(*) FILTER (WHERE catalog_source = 'inferred')               AS via_inferred,
    COUNT(*) FILTER (WHERE catalog_confidence >= 0.85)                AS high_confidence,
    COUNT(*) FILTER (WHERE catalog_confidence < 0.75)                 AS low_confidence
FROM platform_products
WHERE platform = 'snoonu';

COMMENT ON VIEW v_snoonu_catalog_coverage IS
  'Phase 13F.5: at-a-glance Snoonu catalog mapping coverage.';

-- ============================================================================
-- End of migration 0023
-- ============================================================================
