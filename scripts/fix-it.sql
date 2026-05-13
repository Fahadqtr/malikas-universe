-- ========================================================================
-- BULK AI FIX — paste this ENTIRE file into Supabase SQL Editor → Run
-- ========================================================================
-- Two root causes found by the doctor:
--   1. products.ai_confidence ended up as INTEGER (wrong type) so 0.96 fails
--   2. ai_drafts table is missing the ai_meta column (incomplete schema)
-- ========================================================================

-- 1. Force ai_confidence to NUMERIC(3,2). Cast any existing values safely.
ALTER TABLE products
  ALTER COLUMN ai_confidence TYPE NUMERIC(3,2)
  USING ai_confidence::NUMERIC(3,2);

-- 2. Make sure ai_meta is JSONB (also might have wrong type)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='products' AND column_name='ai_meta' AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE products ALTER COLUMN ai_meta TYPE JSONB USING ai_meta::JSONB;
  END IF;
END $$;

-- 3. Drop and recreate ai_drafts with the FULL correct schema
DROP TABLE IF EXISTS ai_drafts CASCADE;

CREATE TABLE ai_drafts (
    id                    BIGSERIAL PRIMARY KEY,
    image_url             TEXT NOT NULL,
    original_filename     TEXT,
    suggestion            JSONB NOT NULL,
    confidence            NUMERIC(3,2),
    ai_meta               JSONB,
    status                TEXT NOT NULL DEFAULT 'pending_recovery'
                          CHECK (status IN ('pending_recovery','recovered','dismissed')),
    error_code            TEXT,
    error_message         TEXT,
    failing_table         TEXT,
    failing_payload       JSONB,
    created_by            TEXT,
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    recovered_at          TIMESTAMPTZ,
    recovered_master_sku  TEXT
);

CREATE INDEX idx_ai_drafts_status   ON ai_drafts(status, created_at DESC);
CREATE INDEX idx_ai_drafts_filename ON ai_drafts(original_filename);

ALTER TABLE ai_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_drafts_all ON ai_drafts;
CREATE POLICY ai_drafts_all ON ai_drafts FOR ALL USING (true) WITH CHECK (true);

-- 4. Force PostgREST to reload its schema cache (CRITICAL after type change)
NOTIFY pgrst, 'reload schema';

-- 5. Verify everything is right
SELECT
    column_name,
    data_type,
    numeric_precision,
    numeric_scale
  FROM information_schema.columns
 WHERE table_name = 'products'
   AND column_name IN ('ai_confidence','ai_meta','ai_generated');
-- Expected:
--   ai_confidence | numeric | 3 | 2
--   ai_meta       | jsonb   |   |
--   ai_generated  | boolean |   |

SELECT count(*) AS ai_drafts_columns
  FROM information_schema.columns
 WHERE table_name = 'ai_drafts';
-- Expected: 16
