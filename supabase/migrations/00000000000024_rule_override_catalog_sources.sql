-- ============================================================================
-- MIGRATION 0024 — Phase 13F.20: Rule override catalog_source values
-- ============================================================================
-- Adds three new catalog_source values used by the Quick Pass corrections:
--   - 'rule_override_brand_priority' (Rhode / Labubu must win)
--   - 'rule_override_hair_specific'  (hair products moved out of Masks/Bundle/Accessories)
--   - 'rule_override_sun_specific'   (SPF products moved out of Face Care/Bundle)
--
-- Idempotent — safe to re-run.
-- ============================================================================

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
        'catalog_section_page',
        'rule_override_brand_priority',     -- Phase 13F.20
        'rule_override_hair_specific',      -- Phase 13F.20
        'rule_override_sun_specific'        -- Phase 13F.20
    ));

COMMENT ON CONSTRAINT platform_products_catalog_source_check ON platform_products IS
  'Phase 13F.20: adds rule_override_* sources for the Quick Pass QA corrections.';

-- ============================================================================
-- End of migration 0024
-- ============================================================================
