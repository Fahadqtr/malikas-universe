-- ============================================================================
-- MIGRATION 0017 — Phase 13B fix: mapping unique indexes for ON CONFLICT
-- ============================================================================
-- Migration 0013 created PARTIAL unique indexes on platform_product_mappings:
--
--   uq_mapping_sku_pair          WHERE target_source_sku IS NOT NULL AND baseline_source_sku IS NOT NULL
--   uq_mapping_master_target_sku WHERE target_source_sku IS NOT NULL AND baseline_master_sku IS NOT NULL
--   uq_mapping_product_pair      WHERE target_product_id IS NOT NULL AND baseline_product_id IS NOT NULL
--
-- Supabase's REST upsert (`{ onConflict: 'col1,col2,col3' }`) can't target
-- partial indexes — Postgres requires the WHERE clause to be specified in the
-- ON CONFLICT clause itself, which the JS client doesn't expose.
--
-- Result: every Create Mapping call fails with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- This migration drops the partial indexes and replaces them with non-partial
-- equivalents. Postgres treats NULL as distinct in unique indexes, so:
--   - Rows with NULL baseline_master_sku won't conflict with each other (which
--     is fine — we route those upserts to the baseline_source_sku index instead)
--   - Rows with the same non-NULL values WILL conflict, which is what we want
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── Drop partial indexes ──────────────────────────────────────────────────
DROP INDEX IF EXISTS uq_mapping_sku_pair;
DROP INDEX IF EXISTS uq_mapping_master_target_sku;
DROP INDEX IF EXISTS uq_mapping_product_pair;

-- ─── Recreate as non-partial unique indexes ────────────────────────────────
-- These can now be targeted by ON CONFLICT (target_platform, target_source_sku, baseline_*)

CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_sku_pair
    ON platform_product_mappings (target_platform, target_source_sku, baseline_source_sku);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_master_target_sku
    ON platform_product_mappings (target_platform, target_source_sku, baseline_master_sku);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_product_pair
    ON platform_product_mappings (target_platform, target_product_id, baseline_product_id);

COMMENT ON INDEX uq_mapping_sku_pair IS
  'Phase 13B.17: non-partial unique — supports ON CONFLICT for Create Mapping upserts';
COMMENT ON INDEX uq_mapping_master_target_sku IS
  'Phase 13B.17: non-partial unique — supports ON CONFLICT for Create Mapping upserts when baseline has a master_sku';

-- ─── Sanity check ──────────────────────────────────────────────────────────
DO $$
DECLARE
    is_partial BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('uq_mapping_sku_pair', 'uq_mapping_master_target_sku', 'uq_mapping_product_pair')
          AND indexdef ILIKE '%WHERE%'
    ) INTO is_partial;
    IF is_partial THEN
        RAISE EXCEPTION 'Sanity check failed: at least one mapping unique index is still PARTIAL after migration 0017';
    END IF;
    RAISE NOTICE 'Migration 0017 OK — all 3 mapping unique indexes are non-partial.';
END $$;

-- ============================================================================
-- End of migration 0017
-- ============================================================================
