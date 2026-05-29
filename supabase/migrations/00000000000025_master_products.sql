-- ============================================================================
-- MIGRATION 0025 — Phase 13G: master_products (canonical source of truth)
-- ============================================================================
-- The Malikas Universe Masterlist xlsx (1,146 rows, 61 columns) becomes the
-- single source of truth for all products.
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS master_products (
    id                       BIGSERIAL PRIMARY KEY,
    master_sku               TEXT,
    snoonu_spi               TEXT,
    masterlist_id            TEXT NOT NULL,
    global_id                TEXT,
    barcode                  TEXT,

    name_en                  TEXT NOT NULL,
    name_ar                  TEXT,
    description_en           TEXT,
    description_ar           TEXT,
    normalized_name          TEXT,

    brand                    TEXT,
    master_category          TEXT,
    snoonu_category          TEXT,
    snoonu_secondary_categories TEXT[] DEFAULT ARRAY[]::TEXT[],
    sub_category             TEXT,
    product_type             TEXT,
    keywords_en              TEXT[] DEFAULT ARRAY[]::TEXT[],
    keywords_ar              TEXT[] DEFAULT ARRAY[]::TEXT[],

    price                    NUMERIC(10,2),
    discount_price           NUMERIC(10,2),
    cost                     NUMERIC(10,2),
    currency                 TEXT NOT NULL DEFAULT 'QAR',

    stock_quantity           INTEGER,
    stock_status             TEXT,

    is_featured              BOOLEAN DEFAULT FALSE,
    is_promoted              BOOLEAN DEFAULT FALSE,
    has_buy1get1             BOOLEAN DEFAULT FALSE,
    product_order_limit      INTEGER,
    preparation_time         INTEGER,
    approval_status          TEXT,
    default_sort_order       INTEGER,
    featured_sort_order      INTEGER,

    shopify_status           TEXT CHECK (shopify_status IS NULL OR shopify_status IN ('active','draft','not_listed','archived')),
    snoonu_status            TEXT CHECK (snoonu_status  IS NULL OR snoonu_status  IN ('active','draft','not_listed','archived')),
    talabat_status           TEXT CHECK (talabat_status IS NULL OR talabat_status IN ('active','draft','not_listed','archived')),
    rafeeq_status            TEXT CHECK (rafeeq_status  IS NULL OR rafeeq_status  IN ('active','draft','not_listed','archived')),

    snoonu_branches          JSONB DEFAULT '[]'::jsonb,

    image_url                TEXT,
    image_filename           TEXT,
    additional_images        JSONB DEFAULT '[]'::jsonb,

    masterlist_raw           JSONB DEFAULT '{}'::jsonb,

    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    masterlist_synced_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_master_masterlist_id ON master_products(masterlist_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_master_sku            ON master_products(master_sku) WHERE master_sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_master_snoonu_spi     ON master_products(snoonu_spi) WHERE snoonu_spi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_category               ON master_products(master_category) WHERE master_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_snoonu_category        ON master_products(snoonu_category) WHERE snoonu_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_brand                  ON master_products(brand) WHERE brand IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_normalized_name        ON master_products(normalized_name) WHERE normalized_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_master_barcode                ON master_products(barcode) WHERE barcode IS NOT NULL;

CREATE OR REPLACE FUNCTION touch_master_products() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_master_products ON master_products;
CREATE TRIGGER trg_touch_master_products
    BEFORE UPDATE ON master_products
    FOR EACH ROW EXECUTE FUNCTION touch_master_products();

CREATE TABLE IF NOT EXISTS master_import_runs (
    id                  BIGSERIAL PRIMARY KEY,
    source_filename     TEXT,
    total_rows          INTEGER NOT NULL DEFAULT 0,
    inserted_rows       INTEGER NOT NULL DEFAULT 0,
    updated_rows        INTEGER NOT NULL DEFAULT 0,
    unchanged_rows      INTEGER NOT NULL DEFAULT 0,
    skipped_rows        INTEGER NOT NULL DEFAULT 0,
    matched_to_snoonu   INTEGER NOT NULL DEFAULT 0,
    new_to_master       INTEGER NOT NULL DEFAULT 0,
    unmapped_columns    TEXT[] DEFAULT ARRAY[]::TEXT[],
    sample_changes      JSONB DEFAULT '[]'::jsonb,
    status              TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','error')),
    error_message       TEXT,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

DROP VIEW IF EXISTS v_master_products_coverage;
CREATE VIEW v_master_products_coverage AS
SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE master_category IS NOT NULL)            AS with_master_category,
    COUNT(*) FILTER (WHERE snoonu_category IS NOT NULL)            AS with_snoonu_category,
    COUNT(*) FILTER (WHERE brand IS NOT NULL)                      AS with_brand,
    COUNT(*) FILTER (WHERE image_url IS NOT NULL)                  AS with_image,
    COUNT(*) FILTER (WHERE master_sku IS NOT NULL)                 AS with_sku,
    COUNT(*) FILTER (WHERE barcode IS NOT NULL)                    AS with_barcode,
    COUNT(*) FILTER (WHERE snoonu_spi IS NOT NULL)                 AS linked_to_snoonu,
    COUNT(*) FILTER (WHERE jsonb_array_length(snoonu_branches) >= 2) AS with_branches,
    COUNT(*) FILTER (WHERE shopify_status = 'active') AS active_on_shopify,
    COUNT(*) FILTER (WHERE snoonu_status  = 'active') AS active_on_snoonu,
    COUNT(*) FILTER (WHERE talabat_status = 'active') AS active_on_talabat,
    COUNT(*) FILTER (WHERE rafeeq_status  = 'active') AS active_on_rafeeq
FROM master_products;