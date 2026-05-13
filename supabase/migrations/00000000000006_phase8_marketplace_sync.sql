-- ============================================================================
-- PHASE 8 — Marketplace sync columns
-- ============================================================================
-- Tracks the result of pushing a product to a marketplace (Shopify first).
-- Adds:
--   1. products.shopify_product_id     BIGINT  — Shopify GID-numeric for fast joins
--   2. products.shopify_handle         TEXT    — URL slug returned by Shopify
--   3. products.shopify_synced_at      TIMESTAMPTZ — last successful push timestamp
--   4. products.readiness_score        SMALLINT — last computed Shopify readiness
--   5. products.readiness_meta         JSONB   — snapshot { target, errors, issues, ... }
--
-- Why BIGINT for shopify_product_id: Shopify product IDs are numeric (e.g. 7864293…).
-- BIGINT comfortably holds them (signed 8-byte).
--
-- Indexes:
--   • idx_products_shopify_id — fast lookup when Shopify webhooks call back to us
--   • idx_products_synced — useful for "show me everything not yet on Shopify"
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add columns
-- ----------------------------------------------------------------------------

ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_product_id BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_handle      TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_synced_at   TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS readiness_score     SMALLINT
    CHECK (readiness_score IS NULL OR (readiness_score >= 0 AND readiness_score <= 100));
ALTER TABLE products ADD COLUMN IF NOT EXISTS readiness_meta      JSONB;

COMMENT ON COLUMN products.shopify_product_id IS
    'Shopify Admin REST product ID. NULL = never pushed. Non-null = update on next push.';
COMMENT ON COLUMN products.shopify_handle IS
    'Shopify URL slug (e.g. medicube-zero-pore-pad-2-0). Generated from product_name_en on first push.';
COMMENT ON COLUMN products.shopify_synced_at IS
    'Timestamp of the last successful Shopify push (create or update).';
COMMENT ON COLUMN products.readiness_score IS
    'Last computed marketplace readiness score (0..100). Cached for fast filtering.';
COMMENT ON COLUMN products.readiness_meta IS
    'Snapshot of the last readiness check: { target, ready, error_count, warning_count, issues[], synced_at }';

-- ----------------------------------------------------------------------------
-- 2. Indexes
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shopify_id
    ON products(shopify_product_id)
    WHERE shopify_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_shopify_synced
    ON products(shopify_synced_at DESC NULLS LAST)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_readiness
    ON products(readiness_score DESC NULLS LAST)
    WHERE deleted_at IS NULL AND product_status = 'active';

-- ----------------------------------------------------------------------------
-- 3. Force PostgREST to pick up the new columns
-- ----------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 4. Verify
-- ----------------------------------------------------------------------------
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name='products'
--      AND column_name IN ('shopify_product_id','shopify_handle','shopify_synced_at',
--                          'readiness_score','readiness_meta');
