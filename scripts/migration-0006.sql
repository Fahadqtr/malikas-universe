-- ========================================================================
-- PHASE 8 — Marketplace Sync Migration (Run once)
-- Paste this entire file into Supabase SQL Editor and click Run.
-- ========================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_product_id BIGINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_handle      TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_synced_at   TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS readiness_score     SMALLINT
    CHECK (readiness_score IS NULL OR (readiness_score >= 0 AND readiness_score <= 100));
ALTER TABLE products ADD COLUMN IF NOT EXISTS readiness_meta      JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shopify_id
    ON products(shopify_product_id)
    WHERE shopify_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_shopify_synced
    ON products(shopify_synced_at DESC NULLS LAST)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_products_readiness
    ON products(readiness_score DESC NULLS LAST)
    WHERE deleted_at IS NULL AND product_status = 'active';

NOTIFY pgrst, 'reload schema';

-- Verify
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_name='products'
   AND column_name IN ('shopify_product_id','shopify_handle','shopify_synced_at',
                       'readiness_score','readiness_meta')
 ORDER BY column_name;
-- Expected: 5 rows
