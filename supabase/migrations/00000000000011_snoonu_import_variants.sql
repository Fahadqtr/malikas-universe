-- ============================================================================
-- MIGRATION 0011 — Phase 13: Snoonu Product Import + Variants + Image Source
-- ============================================================================
-- Adds the infrastructure for importing products from Snoonu (and other
-- platforms) with:
--   1. Batch + item tracking (snoonu_import_batches, snoonu_import_items)
--   2. Parent/child variant linking (product_variants)
--   3. Source-of-truth audit (product_source_links)
--   4. Image source tracking (extends product_images)
--
-- Safety:
--   - All imports go through a review stage. No product is created or updated
--     until an operator approves it on /snoonu-import/[batchId]/review.
--   - SKU is generated FIRST. Image is then renamed to {SKU}.jpg and stored
--     at: product-images/products/{sku-lowercase}/{SKU}.jpg
--   - Duplicate matching via SKU / barcode / brand+name / image hash.
--
-- Idempotent — safe to re-run.
-- ============================================================================

-- ─── 1. Import batches ──────────────────────────────────────────────────────
-- Each batch = one user-triggered import action.
-- Mode tracks how items were sourced (single URL, category URL, paste, upload).
-- Lifecycle: pending → extracting → matching → review_ready → applied / cancelled

CREATE TABLE IF NOT EXISTS snoonu_import_batches (
    id                  BIGSERIAL PRIMARY KEY,
    label               TEXT,                              -- operator-friendly name
    source_mode         TEXT NOT NULL CHECK (source_mode IN (
                            'single_url', 'category_url', 'paste_list',
                            'csv_upload', 'xlsx_upload', 'html_paste'
                        )),
    source_input        TEXT,                              -- raw URL / paste / filename
    total_items         INTEGER NOT NULL DEFAULT 0,
    extracted_count     INTEGER NOT NULL DEFAULT 0,
    matched_count       INTEGER NOT NULL DEFAULT 0,
    variant_count       INTEGER NOT NULL DEFAULT 0,
    blocked_count       INTEGER NOT NULL DEFAULT 0,        -- 403/network failures
    image_failed_count  INTEGER NOT NULL DEFAULT 0,
    applied_count       INTEGER NOT NULL DEFAULT 0,        -- products actually created/updated
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','extracting','matching','review_ready','applying','applied','cancelled','error')),
    error_message       TEXT,
    created_by          UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_snoonu_batches_status ON snoonu_import_batches (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snoonu_batches_creator ON snoonu_import_batches (created_by, created_at DESC) WHERE created_by IS NOT NULL;

COMMENT ON TABLE snoonu_import_batches IS
  'Each row = one operator-triggered Snoonu import session. Drives /snoonu-import/[batchId].';

-- ─── 2. Import items (per-product rows within a batch) ─────────────────────
-- One row per Snoonu product detected/extracted.
-- Holds the FULL extracted payload + matching result + approval action.
--
-- Lifecycle:
--   pending     → just queued
--   extracting  → fetching HTML / parsing
--   extracted   → data parsed, image not yet pulled
--   image_pulled→ image saved to Storage with SKU naming
--   matched     → matching against existing products done
--   reviewed    → operator picked an action
--   applied     → product created/updated in `products` table
--   skipped     → operator chose to skip
--   error       → blocked / parse failed / image failed

CREATE TABLE IF NOT EXISTS snoonu_import_items (
    id                      BIGSERIAL PRIMARY KEY,
    batch_id                BIGINT NOT NULL REFERENCES snoonu_import_batches(id) ON DELETE CASCADE,
    source_platform         TEXT NOT NULL DEFAULT 'snoonu',
    source_url              TEXT NOT NULL,
    source_product_id       TEXT,                          -- Snoonu's internal id when available
    source_image_url        TEXT,                          -- original Snoonu image URL

    -- Extracted product data (raw, before match)
    extracted_name_en       TEXT,
    extracted_name_ar       TEXT,
    extracted_brand         TEXT,
    extracted_category      TEXT,
    extracted_subcategory   TEXT,
    extracted_product_type  TEXT,
    extracted_price         NUMERIC(10,2),
    extracted_discount_price NUMERIC(10,2),
    extracted_currency      TEXT DEFAULT 'QAR',
    extracted_sku           TEXT,
    extracted_barcode       TEXT,
    extracted_description_en TEXT,
    extracted_description_ar TEXT,

    -- Variant detection
    is_variant              BOOLEAN NOT NULL DEFAULT FALSE,
    variant_group_id        TEXT,                          -- groups siblings together (e.g. 'group-uuid')
    variant_type            TEXT CHECK (variant_type IN ('color','shade','size','quantity','bundle','scent','model','type','other') OR variant_type IS NULL),
    variant_name            TEXT,                          -- e.g. 'Color', 'Shade'
    variant_value           TEXT,                          -- e.g. 'Red', '01', '50ml'
    variant_code            TEXT,                          -- normalized suffix for SKU (e.g. 'RED', '01')

    -- SKU + image
    generated_sku           TEXT,                          -- SKU we generated for this item
    parent_sku              TEXT,                          -- if variant, the parent product SKU
    image_filename          TEXT,                          -- {SKU}.jpg
    image_storage_path      TEXT,                          -- products/{sku-lowercase}/{SKU}.jpg
    imported_image_url      TEXT,                          -- Supabase Storage public URL
    image_status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (image_status IN ('pending','downloading','saved','duplicate_skipped','low_quality','failed','no_image')),
    image_quality_issues    JSONB DEFAULT '[]'::jsonb,     -- e.g. ['not_square','low_resolution','non_white_bg']

    -- Match result
    match_status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (match_status IN ('pending','exact','likely','possible','none')),
    matched_product_sku     TEXT REFERENCES products(master_sku) ON DELETE SET NULL,
    match_confidence        NUMERIC(3,2),                  -- 0.00–1.00
    match_reasons           JSONB DEFAULT '[]'::jsonb,     -- e.g. ['sku_exact','name_en_exact']

    -- Operator action
    review_action           TEXT CHECK (review_action IN ('create_new','update_existing','link_variant','skip','needs_manual') OR review_action IS NULL),
    review_notes            TEXT,
    reviewed_by             UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    reviewed_at             TIMESTAMPTZ,

    -- AI enrichment results
    ai_enriched             BOOLEAN NOT NULL DEFAULT FALSE,
    ai_filled_fields        JSONB DEFAULT '[]'::jsonb,     -- e.g. ['name_ar','description_ar','keywords']

    -- Lifecycle
    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','extracting','extracted','image_pulled','matched','reviewed','applied','skipped','error')),
    error_message           TEXT,
    raw_payload             JSONB DEFAULT '{}'::jsonb,     -- full raw scraped/uploaded data

    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snoonu_items_batch ON snoonu_import_items (batch_id, status);
CREATE INDEX IF NOT EXISTS idx_snoonu_items_match ON snoonu_import_items (match_status, batch_id);
CREATE INDEX IF NOT EXISTS idx_snoonu_items_variant ON snoonu_import_items (variant_group_id) WHERE variant_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_snoonu_items_source_url ON snoonu_import_items (source_url);
CREATE INDEX IF NOT EXISTS idx_snoonu_items_generated_sku ON snoonu_import_items (generated_sku) WHERE generated_sku IS NOT NULL;

COMMENT ON TABLE snoonu_import_items IS
  'One row per Snoonu product extracted. Drives /snoonu-import/[batchId]/review.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION touch_snoonu_items() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_snoonu_items ON snoonu_import_items;
CREATE TRIGGER trg_touch_snoonu_items BEFORE UPDATE ON snoonu_import_items
    FOR EACH ROW EXECUTE FUNCTION touch_snoonu_items();

-- ─── 3. product_variants — parent/child linking ─────────────────────────────
-- A product can either:
--   (a) be standalone (no entry here)
--   (b) be a PARENT (has children in this table)
--   (c) be a CHILD (its master_sku appears as variant_sku)
--
-- The parent product holds the marketing copy. Variants inherit but can override.

CREATE TABLE IF NOT EXISTS product_variants (
    id                  BIGSERIAL PRIMARY KEY,
    parent_sku          TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    variant_sku         TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    variant_type        TEXT NOT NULL CHECK (variant_type IN ('color','shade','size','quantity','bundle','scent','model','type','other')),
    variant_name        TEXT,                              -- "Color" / "Shade" / "Size"
    variant_value       TEXT NOT NULL,                     -- "Red" / "01" / "50ml"
    variant_code        TEXT,                              -- normalized suffix (RED, 01, 50ML)
    sort_order          INTEGER NOT NULL DEFAULT 0,
    is_default          BOOLEAN NOT NULL DEFAULT FALSE,    -- which variant is shown first
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (parent_sku, variant_sku),
    CHECK (parent_sku <> variant_sku)
);

CREATE INDEX IF NOT EXISTS idx_variants_parent ON product_variants (parent_sku);
CREATE INDEX IF NOT EXISTS idx_variants_child ON product_variants (variant_sku);

-- Only one default per parent
CREATE UNIQUE INDEX IF NOT EXISTS one_default_variant_per_parent
    ON product_variants (parent_sku) WHERE is_default = TRUE;

COMMENT ON TABLE product_variants IS
  'Parent → child variant relationships. A row exists for every (parent, variant) pair.';

-- ─── 4. product_source_links — where did a product come from? ──────────────
-- Each row records that a product was imported/seen on a specific platform URL.
-- Used for: audit trail, future re-sync, "view on Snoonu" links.

CREATE TABLE IF NOT EXISTS product_source_links (
    id                  BIGSERIAL PRIMARY KEY,
    master_sku          TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    source_platform     TEXT NOT NULL CHECK (source_platform IN ('snoonu','talabat','rafeeq','shopify','manual','other')),
    source_url          TEXT NOT NULL,
    source_product_id   TEXT,
    import_batch_id     BIGINT REFERENCES snoonu_import_batches(id) ON DELETE SET NULL,
    import_item_id      BIGINT REFERENCES snoonu_import_items(id) ON DELETE SET NULL,
    first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (master_sku, source_platform, source_url)
);

CREATE INDEX IF NOT EXISTS idx_source_links_sku ON product_source_links (master_sku);
CREATE INDEX IF NOT EXISTS idx_source_links_platform ON product_source_links (source_platform);
CREATE INDEX IF NOT EXISTS idx_source_links_batch ON product_source_links (import_batch_id) WHERE import_batch_id IS NOT NULL;

COMMENT ON TABLE product_source_links IS
  'Audit trail: every URL/platform where a product has been spotted or imported from.';

-- ─── 5. Extend product_images — source tracking ─────────────────────────────
-- Mark which images came from Snoonu so we can re-pull or replace later.

ALTER TABLE product_images
    ADD COLUMN IF NOT EXISTS source_platform TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS source_url      TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS import_item_id  BIGINT REFERENCES snoonu_import_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_product_images_source ON product_images (source_platform, source_url)
    WHERE source_platform IS NOT NULL;

COMMENT ON COLUMN product_images.source_platform IS
  'Where this image came from: snoonu / talabat / rafeeq / shopify / manual';

-- ─── 6. Add Snoonu fields to products (for future re-sync) ──────────────────
-- snoonu_sku already exists. Add the source URL for cleaner audit.

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS snoonu_url TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_products_snoonu_url ON products (snoonu_url) WHERE snoonu_url IS NOT NULL;

-- ─── 7. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE snoonu_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE snoonu_import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_source_links ENABLE ROW LEVEL SECURITY;

-- Authenticated read (admin app only)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='snoonu_import_batches' AND policyname='auth_read_batches') THEN
        CREATE POLICY auth_read_batches ON snoonu_import_batches FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='snoonu_import_items' AND policyname='auth_read_items') THEN
        CREATE POLICY auth_read_items ON snoonu_import_items FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_variants' AND policyname='auth_read_variants') THEN
        CREATE POLICY auth_read_variants ON product_variants FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='product_source_links' AND policyname='auth_read_source_links') THEN
        CREATE POLICY auth_read_source_links ON product_source_links FOR SELECT TO authenticated USING (true);
    END IF;
END $$;

-- All writes go via service role (API routes).

-- ─── 8. Storage bucket reminder ─────────────────────────────────────────────
-- This migration assumes the 'product-images' Supabase Storage bucket already
-- exists from migration 0002 (phase5_storage.sql).
-- New path convention for Snoonu imports:
--   product-images/products/{sku-lowercase}/{SKU}.jpg
--   product-images/products/{sku-lowercase}/{SKU}-{VARIANT_CODE}.jpg
