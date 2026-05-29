-- ============================================================================
-- ONE-SHOT FIX — apply migrations 0014 + 0015 in a single paste.
-- ============================================================================
-- Paste this entire file into Supabase SQL Editor and run.
-- Fully idempotent — re-running is safe.
--
-- After this succeeds:
--   1. Refresh /reconciliation
--   2. Hit /api/reconciliation/health — should return { ready: true }
--   3. New "Start comparison" run will succeed
-- ============================================================================

-- ─── Migration 0014: finding snapshots ──────────────────────────────────────
ALTER TABLE reconciliation_findings
    ADD COLUMN IF NOT EXISTS baseline_snapshot  JSONB,
    ADD COLUMN IF NOT EXISTS target_snapshot    JSONB,
    ADD COLUMN IF NOT EXISTS matching_reason    TEXT;

CREATE INDEX IF NOT EXISTS idx_findings_baseline_snap_present
    ON reconciliation_findings ((baseline_snapshot IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_findings_target_snap_present
    ON reconciliation_findings ((target_snapshot IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_findings_matching_reason
    ON reconciliation_findings (matching_reason)
    WHERE matching_reason IS NOT NULL;

-- ─── Migration 0015: category extraction ────────────────────────────────────
ALTER TABLE platform_products
    ADD COLUMN IF NOT EXISTS raw_category         TEXT,
    ADD COLUMN IF NOT EXISTS raw_subcategory      TEXT,
    ADD COLUMN IF NOT EXISTS category_name        TEXT,
    ADD COLUMN IF NOT EXISTS subcategory_name     TEXT,
    ADD COLUMN IF NOT EXISTS category_confidence  NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS category_source      TEXT,
    ADD COLUMN IF NOT EXISTS category_missing     BOOLEAN NOT NULL DEFAULT FALSE;

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

-- ─── Sanity check: every expected column now exists ────────────────────────
DO $$
DECLARE
    missing TEXT := '';
BEGIN
    -- Snapshot columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reconciliation_findings' AND column_name='baseline_snapshot') THEN
        missing := missing || ' reconciliation_findings.baseline_snapshot';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reconciliation_findings' AND column_name='target_snapshot') THEN
        missing := missing || ' reconciliation_findings.target_snapshot';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='reconciliation_findings' AND column_name='matching_reason') THEN
        missing := missing || ' reconciliation_findings.matching_reason';
    END IF;
    -- Category columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='platform_products' AND column_name='category_name') THEN
        missing := missing || ' platform_products.category_name';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='platform_products' AND column_name='category_confidence') THEN
        missing := missing || ' platform_products.category_confidence';
    END IF;
    IF length(missing) > 0 THEN
        RAISE EXCEPTION 'Migration apply failed. Still missing:%', missing;
    END IF;
    RAISE NOTICE 'All Phase 13B columns present — reconciliation is ready.';
END $$;
