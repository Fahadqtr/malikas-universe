-- ============================================================================
-- MIGRATION 0021 — Phase 13E.12: per-branch stock + multi-category support
-- ============================================================================
-- Captured during the 3-product Snoonu pilot:
--   1. Stock + price are per-branch on Snoonu (2 branches: Ali Bin Abdullah
--      Street, Al Aziziyah). Total stock = sum across branches.
--   2. Snoonu products can be listed in MULTIPLE categories at once
--      (e.g. "Silicone Skincare Brush" → Beauty Accessories + Face Care).
--
-- Adding:
--   - platform_products.snoonu_branches               JSONB
--   - platform_products.snoonu_secondary_categories   TEXT[]
--   - snoonu_browser_audits.snoonu_branches           JSONB
--   - snoonu_browser_audits.snoonu_secondary_categories TEXT[]
--
-- Shape of snoonu_branches:
--   [
--     { "name": "Ali Bin Abdullah Street", "stock": 10, "price": 89, "available": true },
--     { "name": "Al Aziziyah Building 13, first floor, Apartment 3", "stock": 10, "price": 89, "available": true }
--   ]
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. platform_products ─────────────────────────────────────────────────
ALTER TABLE platform_products
    ADD COLUMN IF NOT EXISTS snoonu_branches             JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS snoonu_secondary_categories TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN platform_products.snoonu_branches IS
  'Phase 13E.12: per-branch stock/price/availability captured from Snoonu Edit Product → Availability & Price tab';
COMMENT ON COLUMN platform_products.snoonu_secondary_categories IS
  'Phase 13E.12: additional Snoonu categories this product is cross-listed in (primary is snoonu_category)';

CREATE INDEX IF NOT EXISTS idx_pp_secondary_cats
    ON platform_products USING gin (snoonu_secondary_categories)
    WHERE array_length(snoonu_secondary_categories, 1) > 0;

CREATE INDEX IF NOT EXISTS idx_pp_branches_present
    ON platform_products ((jsonb_array_length(snoonu_branches) > 0))
    WHERE snoonu_branches IS NOT NULL;

-- ─── 2. snoonu_browser_audits ─────────────────────────────────────────────
ALTER TABLE snoonu_browser_audits
    ADD COLUMN IF NOT EXISTS snoonu_branches             JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS snoonu_secondary_categories TEXT[] DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN snoonu_browser_audits.snoonu_branches IS
  'Phase 13E.12: per-branch capture from Snoonu Availability & Price tab';
COMMENT ON COLUMN snoonu_browser_audits.snoonu_secondary_categories IS
  'Phase 13E.12: extra categories on Snoonu (first goes to snoonu_category, rest here)';

CREATE INDEX IF NOT EXISTS idx_audit_secondary_cats
    ON snoonu_browser_audits USING gin (snoonu_secondary_categories)
    WHERE array_length(snoonu_secondary_categories, 1) > 0;

-- ─── 3. Refresh progress view to include multi-category counts ─────────────
DROP VIEW IF EXISTS v_snoonu_browser_audit_progress;
CREATE VIEW v_snoonu_browser_audit_progress AS
SELECT
    a.import_id,
    COUNT(*)                                                   AS total_audited,
    COUNT(*) FILTER (WHERE a.audit_status = 'pending')         AS pending,
    COUNT(*) FILTER (WHERE a.audit_status = 'audited')         AS audited,
    COUNT(*) FILTER (WHERE a.audit_status = 'verified')        AS verified,
    COUNT(*) FILTER (WHERE a.audit_status = 'applied')         AS applied,
    COUNT(*) FILTER (WHERE a.audit_status = 'skipped')         AS skipped,
    COUNT(*) FILTER (WHERE a.audit_status = 'error')           AS errored,
    COUNT(*) FILTER (WHERE a.has_options = TRUE)               AS options_detected,
    COUNT(*) FILTER (WHERE a.snoonu_catalog IS NOT NULL)       AS catalog_fixed,
    COUNT(*) FILTER (WHERE a.snoonu_price IS NOT NULL)         AS price_captured,
    COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(a.snoonu_branches, '[]'::jsonb)) > 0) AS branches_captured,
    COUNT(*) FILTER (WHERE array_length(a.snoonu_secondary_categories, 1) > 0) AS multi_category,
    MAX(a.audited_at) AS last_audited_at,
    MAX(a.applied_at) AS last_applied_at
FROM snoonu_browser_audits a
GROUP BY a.import_id;

COMMENT ON VIEW v_snoonu_browser_audit_progress IS
  'Phase 13E.12: now includes branches_captured and multi_category counters.';

-- ============================================================================
-- End of migration 0021
-- ============================================================================
