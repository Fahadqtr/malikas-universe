-- ============================================================================
-- MIGRATION 0013 — Phase 13B: Reconciliation Smart Matching
-- ============================================================================
-- Adds:
--   1. Normalized / variant / image columns on platform_products
--   2. Confidence + candidate metadata + extended finding-type list on
--      reconciliation_findings
--   3. New platform_product_mappings table (persistent operator decisions)
--   4. Indexes for fast lookup
--   5. RLS read policies (write goes via service role)
--
-- All statements are idempotent — safe to re-run.
-- Depends on: migration 0012 (reconciliation core schema).
-- ============================================================================

-- ─── 1. platform_products: normalization + variant + image columns ──────────

ALTER TABLE platform_products
    ADD COLUMN IF NOT EXISTS normalized_name         TEXT,
    ADD COLUMN IF NOT EXISTS normalized_brand        TEXT,
    ADD COLUMN IF NOT EXISTS name_root               TEXT,
    ADD COLUMN IF NOT EXISTS name_token_signature    TEXT,

    ADD COLUMN IF NOT EXISTS variant_color           TEXT,
    ADD COLUMN IF NOT EXISTS variant_shade           TEXT,
    ADD COLUMN IF NOT EXISTS variant_size            TEXT,
    ADD COLUMN IF NOT EXISTS variant_volume_value    NUMERIC(10,3),
    ADD COLUMN IF NOT EXISTS variant_volume_unit     TEXT,
    ADD COLUMN IF NOT EXISTS variant_pack            INTEGER,
    ADD COLUMN IF NOT EXISTS variant_model           TEXT,
    ADD COLUMN IF NOT EXISTS variant_type            TEXT,

    ADD COLUMN IF NOT EXISTS image_hash              TEXT,
    ADD COLUMN IF NOT EXISTS image_width             INTEGER,
    ADD COLUMN IF NOT EXISTS image_height            INTEGER;

COMMENT ON COLUMN platform_products.normalized_name       IS 'Phase 13B: lowercase, punctuation-stripped, marketing-words removed';
COMMENT ON COLUMN platform_products.normalized_brand      IS 'Phase 13B: brand lowercased, non-alphanumeric stripped';
COMMENT ON COLUMN platform_products.name_root             IS 'Phase 13B: normalized_name with variant tokens (color/size/pack/model) stripped — used for variant grouping';
COMMENT ON COLUMN platform_products.name_token_signature  IS 'Phase 13B: sorted+deduped tokens for fast Jaccard comparison';
COMMENT ON COLUMN platform_products.variant_volume_unit   IS 'Phase 13B: normalized unit — ml | g | kg | oz | l | cm | mm';
COMMENT ON COLUMN platform_products.image_hash            IS 'Phase 13B placeholder. Phase 13C will populate perceptual hashes.';

-- ─── 2. reconciliation_findings: confidence + candidates + new finding types ─

ALTER TABLE reconciliation_findings
    ADD COLUMN IF NOT EXISTS confidence         NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS candidate_pairs    JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS differing_tokens   TEXT[],
    ADD COLUMN IF NOT EXISTS variant_family_id  TEXT;

-- Drop the old CHECK constraint and add a new one with the extended set.
-- (CHECK constraints can't be ALTERed in place.)
ALTER TABLE reconciliation_findings
    DROP CONSTRAINT IF EXISTS reconciliation_findings_finding_type_check;

ALTER TABLE reconciliation_findings
    ADD CONSTRAINT reconciliation_findings_finding_type_check
    CHECK (finding_type IN (
        -- Phase 13A
        'missing_on_target',
        'missing_on_baseline',
        'price_mismatch',
        'discount_mismatch',
        'name_en_mismatch',
        'name_ar_mismatch',
        'brand_mismatch',
        'category_mismatch',
        'image_mismatch',
        'stock_mismatch',
        'status_mismatch',
        'variant_mismatch',
        'barcode_mismatch',
        'duplicate_on_target',
        -- Phase 13B additions
        'possible_match',
        'variant_missing_on_target',
        'variant_missing_on_baseline',
        'image_filename_mismatch'
    ));

COMMENT ON COLUMN reconciliation_findings.confidence
    IS 'Phase 13B: blended fuzzy score (0..1) for possible_match findings';
COMMENT ON COLUMN reconciliation_findings.candidate_pairs
    IS 'Phase 13B: top alternate matches considered, [{id, score, tier}, ...]';
COMMENT ON COLUMN reconciliation_findings.differing_tokens
    IS 'Phase 13B: tokens that differ between baseline and target names';
COMMENT ON COLUMN reconciliation_findings.variant_family_id
    IS 'Phase 13B: groups variant findings that share the same parent product';

-- ─── 3. platform_product_mappings — persistent operator decisions ───────────
-- Once an operator confirms or dismisses a pair, every future reconciliation
-- run honors that decision. SKU snapshots make the mapping survive even if
-- the underlying platform_products rows get deleted.

CREATE TABLE IF NOT EXISTS platform_product_mappings (
    id                       BIGSERIAL PRIMARY KEY,

    -- Baseline (Snoonu in Phase 13A/13B)
    baseline_platform        TEXT NOT NULL DEFAULT 'snoonu'
                             CHECK (baseline_platform IN ('snoonu','talabat','rafeeq','shopify','internal')),
    baseline_product_id      BIGINT REFERENCES platform_products(id) ON DELETE SET NULL,
    baseline_master_sku      TEXT,
    baseline_source_sku      TEXT,
    baseline_name_snapshot   TEXT,

    -- Target platform
    target_platform          TEXT NOT NULL
                             CHECK (target_platform IN ('snoonu','talabat','rafeeq','shopify','internal','other')),
    target_product_id        BIGINT REFERENCES platform_products(id) ON DELETE SET NULL,
    target_source_sku        TEXT,
    target_source_id         TEXT,
    target_name_snapshot     TEXT,

    -- Decision type
    mapping_type             TEXT NOT NULL CHECK (mapping_type IN (
                                'confirmed_match',
                                'ignored_pair',
                                'manual_link',
                                'variant_link'
                             )),
    confidence               NUMERIC(3,2),
    notes                    TEXT,

    created_by               UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE platform_product_mappings IS
  'Phase 13B: Persistent operator-confirmed product pairings (or ignored false-positives). Future reconciliation runs honor these.';

-- ─── 4. Indexes ─────────────────────────────────────────────────────────────

-- platform_products: speed up normalized lookup + variant grouping
CREATE INDEX IF NOT EXISTS idx_pp_normalized_name   ON platform_products (normalized_name)
    WHERE normalized_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_name_root         ON platform_products (name_root)
    WHERE name_root IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_norm_brand        ON platform_products (normalized_brand)
    WHERE normalized_brand IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_variant_color     ON platform_products (variant_color)
    WHERE variant_color IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_variant_size      ON platform_products (variant_size)
    WHERE variant_size IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_variant_pack      ON platform_products (variant_pack)
    WHERE variant_pack IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_variant_model     ON platform_products (variant_model)
    WHERE variant_model IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_image_hash        ON platform_products (image_hash)
    WHERE image_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pp_brand_root        ON platform_products (normalized_brand, name_root)
    WHERE name_root IS NOT NULL;

-- Trigram index on normalized_name for fast fuzzy candidate selection (only
-- if the pg_trgm extension is installed — set up in migration 0001).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_pp_norm_name_trgm
                 ON platform_products USING gin (normalized_name gin_trgm_ops)
                 WHERE normalized_name IS NOT NULL';
    END IF;
END $$;

-- reconciliation_findings: indexes on new columns
CREATE INDEX IF NOT EXISTS idx_findings_confidence
    ON reconciliation_findings (confidence DESC NULLS LAST)
    WHERE confidence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_variant_family
    ON reconciliation_findings (variant_family_id)
    WHERE variant_family_id IS NOT NULL;

-- platform_product_mappings: lookup paths
CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_product_pair
    ON platform_product_mappings (target_platform, target_product_id, baseline_product_id)
    WHERE target_product_id IS NOT NULL AND baseline_product_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_sku_pair
    ON platform_product_mappings (target_platform, target_source_sku, baseline_source_sku)
    WHERE target_source_sku IS NOT NULL AND baseline_source_sku IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mapping_master_target_sku
    ON platform_product_mappings (target_platform, target_source_sku, baseline_master_sku)
    WHERE target_source_sku IS NOT NULL AND baseline_master_sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mappings_target_platform
    ON platform_product_mappings (target_platform, mapping_type);
CREATE INDEX IF NOT EXISTS idx_mappings_master_sku
    ON platform_product_mappings (baseline_master_sku)
    WHERE baseline_master_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mappings_baseline_product
    ON platform_product_mappings (baseline_product_id)
    WHERE baseline_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mappings_target_product
    ON platform_product_mappings (target_product_id)
    WHERE target_product_id IS NOT NULL;

-- ─── 5. updated_at trigger on mappings ──────────────────────────────────────

CREATE OR REPLACE FUNCTION touch_platform_mappings() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_platform_mappings ON platform_product_mappings;
CREATE TRIGGER trg_touch_platform_mappings
    BEFORE UPDATE ON platform_product_mappings
    FOR EACH ROW EXECUTE FUNCTION touch_platform_mappings();

-- ─── 6. RLS — authenticated read, writes go via service role ────────────────

ALTER TABLE platform_product_mappings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'platform_product_mappings'
          AND policyname = 'auth_read_mappings'
    ) THEN
        CREATE POLICY auth_read_mappings
            ON platform_product_mappings
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;
END $$;

-- ─── 7. Convenience view: pending findings minus ignored pairs ──────────────

CREATE OR REPLACE VIEW v_findings_pending AS
SELECT f.*
FROM reconciliation_findings f
LEFT JOIN platform_product_mappings m
       ON  m.target_platform = f.target_platform
       AND m.mapping_type    = 'ignored_pair'
       AND (
              (m.target_product_id IS NOT NULL AND m.target_product_id = f.target_product_id)
              OR
              (
                m.target_source_sku IS NOT NULL
                AND m.target_source_sku = (
                    SELECT source_sku
                    FROM platform_products
                    WHERE id = f.target_product_id
                )
                AND (
                  (m.baseline_master_sku IS NOT NULL AND m.baseline_master_sku = f.master_sku)
                  OR
                  (m.baseline_source_sku IS NOT NULL AND m.baseline_source_sku = (
                      SELECT source_sku
                      FROM platform_products
                      WHERE id = f.baseline_product_id
                  ))
                )
              )
       )
WHERE f.resolution_status = 'pending'
  AND m.id IS NULL;

COMMENT ON VIEW v_findings_pending IS
  'Phase 13B: Findings still needing review — excludes pairs the operator has marked as ignored.';

-- ============================================================================
-- End of migration 0013 — reconciliation smart matching
-- ============================================================================
