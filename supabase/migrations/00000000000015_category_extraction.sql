-- ============================================================================
-- MIGRATION 0015 — Phase 13B.14: Category extraction columns
-- ============================================================================
-- Every imported platform product now records:
--   - raw_category / raw_subcategory          : exact value from the source column
--   - category_name / subcategory_name        : canonical (cleaned + mapped)
--   - category_confidence                     : 0..1 quality of the assignment
--   - category_source                         : where the category came from
--   - category_missing                        : true when we couldn't determine one
--
-- category_source values:
--   'direct_column'   — a recognized category column had a value
--   'inferred_rule'   — keyword/brand rule fired
--   'inferred_ai'     — reserved for future LLM enrichment
--   'manual'          — operator set it via the import preview UI
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE platform_products
    ADD COLUMN IF NOT EXISTS raw_category         TEXT,
    ADD COLUMN IF NOT EXISTS raw_subcategory      TEXT,
    ADD COLUMN IF NOT EXISTS category_name        TEXT,
    ADD COLUMN IF NOT EXISTS subcategory_name     TEXT,
    ADD COLUMN IF NOT EXISTS category_confidence  NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS category_source      TEXT,
    ADD COLUMN IF NOT EXISTS category_missing     BOOLEAN NOT NULL DEFAULT FALSE;

-- Add CHECK constraint on category_source. Use DROP/ADD pattern so re-runs
-- don't fail.
ALTER TABLE platform_products
    DROP CONSTRAINT IF EXISTS platform_products_category_source_check;

ALTER TABLE platform_products
    ADD CONSTRAINT platform_products_category_source_check
    CHECK (category_source IS NULL OR category_source IN (
        'direct_column',
        'inferred_rule',
        'inferred_ai',
        'manual'
    ));

COMMENT ON COLUMN platform_products.raw_category
    IS 'Phase 13B.14: exact value from the source platform''s category column, before normalization';
COMMENT ON COLUMN platform_products.raw_subcategory
    IS 'Phase 13B.14: exact value from the source platform''s sub-category column';
COMMENT ON COLUMN platform_products.category_name
    IS 'Phase 13B.14: canonical category — either the platform value cleaned, or inferred from keywords/brand';
COMMENT ON COLUMN platform_products.subcategory_name
    IS 'Phase 13B.14: canonical sub-category';
COMMENT ON COLUMN platform_products.category_confidence
    IS 'Phase 13B.14: 1.00 for direct_column, 0.70-0.95 for inferred_rule, NULL when category_missing';
COMMENT ON COLUMN platform_products.category_source
    IS 'Phase 13B.14: direct_column | inferred_rule | inferred_ai | manual';
COMMENT ON COLUMN platform_products.category_missing
    IS 'Phase 13B.14: true when the extractor could not determine any category — these rows show up in the "Missing category" tab and the import preview UI';

-- Indexes for diagnostics + dashboard filters
CREATE INDEX IF NOT EXISTS idx_pp_category_name
    ON platform_products (category_name)
    WHERE category_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_category_source
    ON platform_products (category_source)
    WHERE category_source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_category_missing
    ON platform_products (category_missing)
    WHERE category_missing = TRUE;
CREATE INDEX IF NOT EXISTS idx_pp_raw_category
    ON platform_products (raw_category)
    WHERE raw_category IS NOT NULL;

-- ============================================================================
-- End of migration 0015 — category extraction
-- ============================================================================
