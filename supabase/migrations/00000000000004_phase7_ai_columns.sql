-- ============================================================================
-- PHASE 7 — AI generation tracking + Unknown brand fallback
-- ============================================================================
-- Bulk AI pipeline auto-creates DRAFT products from a single product image.
-- Owner must review every AI draft before activation.
--
-- Adds:
--   1. products.ai_generated   BOOLEAN  — TRUE when row was auto-created by AI
--   2. products.ai_confidence  NUMERIC  — 0.00..1.00 from Claude vision
--   3. products.ai_meta        JSONB    — model, tokens, cost, latency, filename, reasoning
--   4. Brand "Unknown"                  — fallback when Claude can't identify brand
--   5. Index for filtering AI-generated drafts by confidence
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. AI tracking columns on products
-- ----------------------------------------------------------------------------

ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(3,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_meta JSONB;

COMMENT ON COLUMN products.ai_generated IS
    'TRUE when this row was auto-created by Bulk AI from a single image. Owner must manually review before activation.';
COMMENT ON COLUMN products.ai_confidence IS
    'Confidence 0.00..1.00 from Claude vision. <0.90 means human review required, <0.75 means high risk.';
COMMENT ON COLUMN products.ai_meta IS
    'Snapshot of the AI run: { model, input_tokens, output_tokens, cost_usd, latency_ms, original_filename, reasoning }';

-- ----------------------------------------------------------------------------
-- 2. Index for the "review queue" view (AI drafts sorted by confidence)
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_products_ai_drafts
    ON products(ai_confidence ASC, created_at DESC)
    WHERE ai_generated = TRUE AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- 3. Fallback brand — used when Claude cannot identify brand from the package
-- ----------------------------------------------------------------------------

INSERT INTO brands (name, name_ar, code, country_origin) VALUES
    ('Unknown', 'غير محدد', 'UNK', 'Unknown')
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Verify
-- ----------------------------------------------------------------------------
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'products' AND column_name IN ('ai_generated','ai_confidence','ai_meta');
--   SELECT id, name FROM brands WHERE name = 'Unknown';
