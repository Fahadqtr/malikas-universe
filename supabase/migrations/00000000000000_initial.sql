-- ============================================================================
-- MALIKA'S UNIVERSE — CONSOLIDATED INITIAL MIGRATION
-- ============================================================================
-- Run this entire file in Supabase Dashboard → SQL Editor → New Query
-- Creates all 24 tables, indexes, triggers, RLS policies, seed data, functions, views.
-- Safe to run once. Re-running will partially fail (CREATE TABLE not idempotent).
-- ============================================================================

-- ============================================================================
-- 001 — Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================================
-- 002 — Core Schema (19 tables)
-- ============================================================================

CREATE TABLE categories (
    id              SERIAL PRIMARY KEY,
    name            TEXT UNIQUE NOT NULL,
    code            TEXT UNIQUE NOT NULL,
    name_ar         TEXT,
    priority        INTEGER NOT NULL,
    display_order   INTEGER,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE subcategories (
    id              SERIAL PRIMARY KEY,
    category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    name            TEXT NOT NULL,
    name_ar         TEXT,
    display_order   INTEGER,
    is_active       BOOLEAN DEFAULT TRUE,
    UNIQUE(category_id, name)
);

CREATE TABLE brands (
    id              SERIAL PRIMARY KEY,
    name            CITEXT UNIQUE NOT NULL,
    name_ar         TEXT,
    code            TEXT UNIQUE,
    country_origin  TEXT,
    logo_url        TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE category_rules (
    id              SERIAL PRIMARY KEY,
    brand_id        INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    default_subcategory_id INTEGER REFERENCES subcategories(id),
    confidence      NUMERIC(3,2) DEFAULT 1.00,
    UNIQUE(brand_id)
);

CREATE TABLE keyword_rules (
    id              SERIAL PRIMARY KEY,
    keyword         TEXT NOT NULL,
    language        TEXT NOT NULL CHECK (language IN ('en','ar')),
    category_id     INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    subcategory_id  INTEGER REFERENCES subcategories(id) ON DELETE CASCADE,
    confidence      NUMERIC(3,2) DEFAULT 0.95,
    UNIQUE(keyword, language)
);

CREATE TABLE sku_counter (
    prefix          TEXT PRIMARY KEY,
    sequence        INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE products (
    id                  BIGSERIAL PRIMARY KEY,
    master_sku          TEXT UNIQUE NOT NULL,
    detailed_sku        TEXT,
    snoonu_sku          TEXT,
    barcode             TEXT,
    product_name_en     TEXT NOT NULL,
    product_name_ar     TEXT NOT NULL,
    brand_id            INTEGER NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
    category_id         INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    subcategory_id      INTEGER REFERENCES subcategories(id) ON DELETE SET NULL,
    product_type        TEXT,
    variant             TEXT,
    color               TEXT,
    size                TEXT,
    price               NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    discount_price      NUMERIC(10,2) CHECK (discount_price >= 0),
    cost                NUMERIC(10,2) CHECK (cost >= 0),
    stock_quantity      INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
    stock_status        TEXT NOT NULL DEFAULT 'in_stock'
                        CHECK (stock_status IN ('in_stock','low_stock','out_of_stock','pre_order','discontinued')),
    product_status      TEXT NOT NULL DEFAULT 'draft'
                        CHECK (product_status IN ('draft','pending_approval','active','archived','blocked')),
    image_url           TEXT,
    image_filename      TEXT,
    description_en      TEXT,
    description_ar      TEXT,
    keywords_en         TEXT[],
    keywords_ar         TEXT[],
    source_platform     TEXT NOT NULL DEFAULT 'snoonu'
                        CHECK (source_platform IN ('snoonu','shopify','talabat','rafeeq','manual','import')),
    embedding           VECTOR(1536),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    created_by          TEXT,
    updated_by          TEXT,
    CONSTRAINT discount_below_price CHECK (
        discount_price IS NULL OR discount_price < price
    )
);

CREATE TABLE product_images (
    id              BIGSERIAL PRIMARY KEY,
    master_sku      TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    r2_key          TEXT NOT NULL,
    cdn_url         TEXT NOT NULL,
    filename        TEXT NOT NULL,
    is_primary      BOOLEAN DEFAULT FALSE,
    width           INTEGER,
    height          INTEGER,
    format          TEXT,
    file_size_kb    INTEGER,
    phash           TEXT,
    is_broken       BOOLEAN DEFAULT FALSE,
    uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
    uploaded_by     TEXT
);

CREATE UNIQUE INDEX one_primary_image_per_sku
    ON product_images(master_sku) WHERE is_primary = TRUE;

CREATE TABLE platform_mappings (
    id                  BIGSERIAL PRIMARY KEY,
    master_sku          TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    platform            TEXT NOT NULL
                        CHECK (platform IN ('snoonu','shopify','talabat','rafeeq','website')),
    platform_product_id TEXT,
    platform_sku        TEXT,
    platform_price      NUMERIC(10,2),
    platform_status     TEXT
                        CHECK (platform_status IN ('active','draft','not_listed','out_of_stock','rejected')),
    platform_url        TEXT,
    last_synced_at      TIMESTAMPTZ,
    last_sync_status    TEXT,
    sync_error          TEXT,
    UNIQUE(master_sku, platform)
);

CREATE TABLE inventory (
    id              BIGSERIAL PRIMARY KEY,
    master_sku      TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    change_type     TEXT NOT NULL
                    CHECK (change_type IN ('restock','sale','return','adjustment','damaged','expired')),
    quantity_delta  INTEGER NOT NULL,
    quantity_after  INTEGER NOT NULL,
    reason          TEXT,
    platform        TEXT,
    reference_id    TEXT,
    actor           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE price_history (
    id              BIGSERIAL PRIMARY KEY,
    master_sku      TEXT NOT NULL REFERENCES products(master_sku) ON DELETE CASCADE,
    old_price       NUMERIC(10,2),
    new_price       NUMERIC(10,2) NOT NULL,
    old_discount    NUMERIC(10,2),
    new_discount    NUMERIC(10,2),
    reason          TEXT,
    actor           TEXT,
    changed_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE product_logs (
    id              BIGSERIAL PRIMARY KEY,
    master_sku      TEXT NOT NULL,
    field_name      TEXT NOT NULL,
    old_value       JSONB,
    new_value       JSONB,
    actor           TEXT,
    source          TEXT,
    changed_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE validation_issues (
    id              BIGSERIAL PRIMARY KEY,
    master_sku      TEXT REFERENCES products(master_sku) ON DELETE CASCADE,
    rule_id         TEXT NOT NULL,
    severity        TEXT NOT NULL
                    CHECK (severity IN ('critical','high','medium','low')),
    field_name      TEXT,
    message         TEXT NOT NULL,
    suggested_fix   TEXT,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_review','resolved','wont_fix')),
    resolved_by     TEXT,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ai_training_data (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT NOT NULL
                    CHECK (type IN ('faq','product_qa','complaint_resolution','escalation_example')),
    question        TEXT NOT NULL,
    answer          TEXT NOT NULL,
    language        TEXT NOT NULL CHECK (language IN ('en','ar')),
    master_sku      TEXT REFERENCES products(master_sku),
    embedding       VECTOR(1536),
    tags            TEXT[],
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE conversations (
    id              BIGSERIAL PRIMARY KEY,
    customer_phone  TEXT UNIQUE NOT NULL,
    customer_name   TEXT,
    language        TEXT CHECK (language IN ('en','ar','mixed')),
    last_message_at TIMESTAMPTZ,
    status          TEXT DEFAULT 'open'
                    CHECK (status IN ('open','escalated','resolved','spam')),
    escalated       BOOLEAN DEFAULT FALSE,
    total_messages  INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    body            TEXT NOT NULL,
    media_url       TEXT,
    ai_model        TEXT,
    ai_confidence   NUMERIC(3,2),
    intent          TEXT,
    tools_called    JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE escalations (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
    customer_phone  TEXT NOT NULL,
    reason          TEXT NOT NULL
                    CHECK (reason IN ('refund_over_100','fake_claim','abusive','repeat_complaint','low_confidence','manual','complex_query')),
    severity        TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
    summary         TEXT,
    assigned_to     TEXT,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','resolved','closed')),
    resolution_notes TEXT,
    sla_due_at      TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE import_batches (
    id              BIGSERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,
    source_platform TEXT,
    total_rows      INTEGER,
    success_rows    INTEGER,
    error_rows      INTEGER,
    skipped_rows    INTEGER,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','validating','importing','completed','failed','rolled_back')),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    initiated_by    TEXT,
    error_summary   JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE import_errors (
    id              BIGSERIAL PRIMARY KEY,
    batch_id        BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    row_number      INTEGER,
    raw_data        JSONB,
    error_type      TEXT,
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE review_queue (
    id              BIGSERIAL PRIMARY KEY,
    master_sku      TEXT REFERENCES products(master_sku) ON DELETE CASCADE,
    review_type     TEXT NOT NULL
                    CHECK (review_type IN ('category_reassignment','platform_match','duplicate_suspected','price_mismatch','image_duplicate','low_ai_confidence','customer_report')),
    confidence      NUMERIC(5,2),
    suggested_value JSONB,
    current_value   JSONB,
    evidence        JSONB,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','modified','escalated')),
    reviewed_by     TEXT,
    reviewer_notes  TEXT,
    sla_due_at      TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE automation_log (
    id              BIGSERIAL PRIMARY KEY,
    workflow_name   TEXT NOT NULL,
    execution_id    TEXT,
    started_at      TIMESTAMPTZ NOT NULL,
    finished_at     TIMESTAMPTZ,
    status          TEXT NOT NULL CHECK (status IN ('running','success','error','retried')),
    rows_processed  INTEGER,
    duration_ms     INTEGER,
    errors          JSONB,
    metadata        JSONB
);

CREATE TABLE user_profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email           CITEXT UNIQUE NOT NULL,
    full_name       TEXT,
    role            TEXT NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('owner','editor','viewer')),
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- 008 — Settings + AI cache + AI usage (added here so they exist before RLS)
-- ============================================================================

CREATE TABLE system_settings (
    key             TEXT PRIMARY KEY,
    value           JSONB NOT NULL,
    description     TEXT,
    updated_by      TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ai_search_cache (
    id              BIGSERIAL PRIMARY KEY,
    query_hash      TEXT UNIQUE NOT NULL,
    query_text      TEXT NOT NULL,
    query_language  TEXT CHECK (query_language IN ('en','ar','mixed')),
    result          JSONB NOT NULL,
    tools_called    TEXT[],
    hit_count       INTEGER NOT NULL DEFAULT 1,
    last_accessed   TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE ai_usage_log (
    id                  BIGSERIAL PRIMARY KEY,
    conversation_id     BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
    model               TEXT NOT NULL,
    operation           TEXT,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER DEFAULT 0,
    cost_usd            NUMERIC(10,6),
    latency_ms          INTEGER,
    cache_hit           BOOLEAN DEFAULT FALSE,
    success             BOOLEAN NOT NULL DEFAULT TRUE,
    error_message       TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- 003 — Performance Indexes
-- ============================================================================

CREATE INDEX idx_products_brand            ON products(brand_id);
CREATE INDEX idx_products_category         ON products(category_id);
CREATE INDEX idx_products_subcategory      ON products(subcategory_id);
CREATE INDEX idx_products_barcode          ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_snoonu_sku       ON products(snoonu_sku) WHERE snoonu_sku IS NOT NULL;
CREATE INDEX idx_products_status_active    ON products(product_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_stock_status     ON products(stock_status);
CREATE INDEX idx_products_name_en_trgm     ON products USING gin(product_name_en gin_trgm_ops);
CREATE INDEX idx_products_name_ar_trgm     ON products USING gin(product_name_ar gin_trgm_ops);
CREATE INDEX idx_products_embedding        ON products USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_products_keywords_en      ON products USING gin(keywords_en);
CREATE INDEX idx_products_keywords_ar      ON products USING gin(keywords_ar);
CREATE INDEX idx_products_not_deleted      ON products(id) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_updated_at       ON products(updated_at DESC);

CREATE INDEX idx_platform_mappings_lookup  ON platform_mappings(platform, platform_sku);
CREATE INDEX idx_platform_mappings_sku     ON platform_mappings(master_sku);
CREATE INDEX idx_platform_mappings_status  ON platform_mappings(platform, platform_status);

CREATE INDEX idx_product_images_sku        ON product_images(master_sku);
CREATE INDEX idx_product_images_phash      ON product_images(phash) WHERE phash IS NOT NULL;
CREATE INDEX idx_product_images_broken     ON product_images(is_broken) WHERE is_broken = TRUE;

CREATE INDEX idx_product_logs_sku_time     ON product_logs(master_sku, changed_at DESC);
CREATE INDEX idx_product_logs_actor        ON product_logs(actor, changed_at DESC);

CREATE INDEX idx_validation_issues_open    ON validation_issues(severity, master_sku) WHERE status = 'open';
CREATE INDEX idx_validation_issues_sku     ON validation_issues(master_sku);

CREATE INDEX idx_inventory_sku_time        ON inventory(master_sku, created_at DESC);
CREATE INDEX idx_price_history_sku_time    ON price_history(master_sku, changed_at DESC);

CREATE INDEX idx_conversations_phone       ON conversations(customer_phone);
CREATE INDEX idx_conversations_status      ON conversations(status, last_message_at DESC);
CREATE INDEX idx_messages_conv_time        ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_intent           ON messages(intent) WHERE intent IS NOT NULL;

CREATE INDEX idx_escalations_open          ON escalations(status, severity, sla_due_at) WHERE status IN ('open','in_progress');
CREATE INDEX idx_escalations_phone         ON escalations(customer_phone);

CREATE INDEX idx_review_queue_pending      ON review_queue(review_type, created_at) WHERE status = 'pending';
CREATE INDEX idx_review_queue_sku          ON review_queue(master_sku);

CREATE INDEX idx_import_batches_status     ON import_batches(status, created_at DESC);
CREATE INDEX idx_import_errors_batch       ON import_errors(batch_id);

CREATE INDEX idx_ai_training_embedding     ON ai_training_data USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_ai_training_lang_type     ON ai_training_data(language, type) WHERE is_active = TRUE;

CREATE INDEX idx_keyword_rules_lookup      ON keyword_rules(language, keyword);

CREATE INDEX idx_automation_log_workflow   ON automation_log(workflow_name, started_at DESC);
CREATE INDEX idx_automation_log_errors     ON automation_log(status, started_at DESC) WHERE status = 'error';

CREATE INDEX idx_ai_cache_hash             ON ai_search_cache(query_hash);
CREATE INDEX idx_ai_cache_expires          ON ai_search_cache(expires_at);
CREATE INDEX idx_ai_usage_time             ON ai_usage_log(created_at DESC);
CREATE INDEX idx_ai_usage_model            ON ai_usage_log(model, created_at DESC);
CREATE INDEX idx_ai_usage_errors           ON ai_usage_log(success, created_at DESC) WHERE success = FALSE;

-- ============================================================================
-- 004 — Triggers + Functions
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_settings_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION generate_master_sku(p_category_code TEXT)
RETURNS TEXT AS $$
DECLARE
    next_seq INTEGER;
    new_sku  TEXT;
BEGIN
    INSERT INTO sku_counter(prefix, sequence)
    VALUES (p_category_code, 0)
    ON CONFLICT (prefix) DO NOTHING;

    UPDATE sku_counter
       SET sequence = sequence + 1, updated_at = NOW()
     WHERE prefix = p_category_code
    RETURNING sequence INTO next_seq;

    new_sku := 'MK-' || p_category_code || '-' || LPAD(next_seq::TEXT, 4, '0');

    IF EXISTS (SELECT 1 FROM products WHERE master_sku = new_sku) THEN
        RAISE EXCEPTION 'Generated SKU % already exists', new_sku;
    END IF;

    RETURN new_sku;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auto_assign_master_sku()
RETURNS TRIGGER AS $$
DECLARE
    cat_code TEXT;
BEGIN
    IF NEW.master_sku IS NULL OR NEW.master_sku = '' THEN
        SELECT code INTO cat_code FROM categories WHERE id = NEW.category_id;
        IF cat_code IS NULL THEN
            RAISE EXCEPTION 'Invalid category_id %', NEW.category_id;
        END IF;
        NEW.master_sku := generate_master_sku(cat_code);
        NEW.image_filename := NEW.master_sku || '.jpg';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_assign_sku
    BEFORE INSERT ON products
    FOR EACH ROW EXECUTE FUNCTION auto_assign_master_sku();

CREATE OR REPLACE FUNCTION log_product_changes()
RETURNS TRIGGER AS $$
DECLARE
    tracked_fields TEXT[] := ARRAY[
        'product_name_en','product_name_ar','brand_id','category_id','subcategory_id',
        'product_type','variant','color','size','price','discount_price','cost',
        'stock_quantity','stock_status','product_status','image_url',
        'description_en','description_ar','keywords_en','keywords_ar'
    ];
    f TEXT;
    old_val JSONB;
    new_val JSONB;
BEGIN
    FOREACH f IN ARRAY tracked_fields LOOP
        old_val := to_jsonb(OLD) -> f;
        new_val := to_jsonb(NEW) -> f;
        IF old_val IS DISTINCT FROM new_val THEN
            INSERT INTO product_logs(master_sku, field_name, old_value, new_value, actor, source)
            VALUES (NEW.master_sku, f, old_val, new_val,
                    COALESCE(NEW.updated_by, 'system'), 'trigger');
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_audit
    AFTER UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION log_product_changes();

CREATE OR REPLACE FUNCTION log_price_change()
RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.price IS DISTINCT FROM NEW.price)
       OR (OLD.discount_price IS DISTINCT FROM NEW.discount_price) THEN
        INSERT INTO price_history(master_sku, old_price, new_price, old_discount, new_discount, actor)
        VALUES (NEW.master_sku, OLD.price, NEW.price,
                OLD.discount_price, NEW.discount_price,
                COALESCE(NEW.updated_by, 'system'));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_price_history
    AFTER UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION log_price_change();

CREATE OR REPLACE FUNCTION auto_stock_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.stock_quantity = 0 THEN
        NEW.stock_status := 'out_of_stock';
    ELSIF NEW.stock_quantity <= 5 THEN
        NEW.stock_status := 'low_stock';
    ELSIF NEW.stock_status = 'out_of_stock' OR NEW.stock_status = 'low_stock' THEN
        NEW.stock_status := 'in_stock';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_stock_status
    BEFORE INSERT OR UPDATE OF stock_quantity ON products
    FOR EACH ROW EXECUTE FUNCTION auto_stock_status();

CREATE OR REPLACE FUNCTION update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conversations
       SET total_messages = total_messages + 1,
           last_message_at = NEW.created_at
     WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_update_conversation
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_conversation_on_message();

CREATE OR REPLACE FUNCTION soft_delete_product(p_master_sku TEXT, p_actor TEXT)
RETURNS VOID AS $$
BEGIN
    UPDATE products
       SET deleted_at = NOW(),
           product_status = 'archived',
           updated_by = p_actor
     WHERE master_sku = p_master_sku;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rollback_product(p_master_sku TEXT, p_target_time TIMESTAMPTZ)
RETURNS VOID AS $$
DECLARE
    rec RECORD;
    sql TEXT;
BEGIN
    FOR rec IN
        SELECT field_name, old_value
          FROM product_logs
         WHERE master_sku = p_master_sku
           AND changed_at > p_target_time
         ORDER BY changed_at DESC
    LOOP
        sql := format('UPDATE products SET %I = $1 WHERE master_sku = $2', rec.field_name);
        EXECUTE sql USING rec.old_value, p_master_sku;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_expired_ai_cache()
RETURNS INTEGER AS $$
DECLARE deleted_count INTEGER;
BEGIN
    DELETE FROM ai_search_cache WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_setting_text(p_key TEXT)
RETURNS TEXT AS $$
    SELECT value #>> '{}' FROM system_settings WHERE key = p_key;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION get_setting_numeric(p_key TEXT)
RETURNS NUMERIC AS $$
    SELECT (value)::TEXT::NUMERIC FROM system_settings WHERE key = p_key;
$$ LANGUAGE SQL STABLE;

-- ============================================================================
-- 005 — Row Level Security
-- ============================================================================

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT AS $$
    SELECT role FROM user_profiles WHERE id = auth.uid();
$$ LANGUAGE SQL STABLE;

ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_mappings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory           ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_history       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE validation_issues   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_training_data    ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_search_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue        ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_errors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE subcategories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands              ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_rules       ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings     ENABLE ROW LEVEL SECURITY;

CREATE POLICY products_select ON products FOR SELECT
    USING (auth.role() = 'authenticated' AND current_user_role() IN ('owner','editor','viewer'));
CREATE POLICY products_insert ON products FOR INSERT
    WITH CHECK (current_user_role() IN ('owner','editor'));
CREATE POLICY products_update ON products FOR UPDATE
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY products_delete ON products FOR DELETE
    USING (current_user_role() = 'owner');

CREATE POLICY product_logs_select ON product_logs FOR SELECT
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY price_history_select ON price_history FOR SELECT
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY inventory_select ON inventory FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));
CREATE POLICY inventory_insert ON inventory FOR INSERT
    WITH CHECK (current_user_role() IN ('owner','editor','viewer'));
CREATE POLICY automation_log_select ON automation_log FOR SELECT
    USING (current_user_role() IN ('owner','editor'));

CREATE POLICY categories_select ON categories FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY subcategories_select ON subcategories FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY brands_select ON brands FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY category_rules_select ON category_rules FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY keyword_rules_select ON keyword_rules FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY brands_write ON brands FOR ALL USING (current_user_role() = 'owner');
CREATE POLICY subcategories_write ON subcategories FOR ALL USING (current_user_role() = 'owner');
CREATE POLICY category_rules_write ON category_rules FOR ALL USING (current_user_role() = 'owner');
CREATE POLICY keyword_rules_write ON keyword_rules FOR ALL USING (current_user_role() = 'owner');

CREATE POLICY product_images_all ON product_images FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

CREATE POLICY platform_mappings_all ON platform_mappings FOR ALL
    USING (current_user_role() IN ('owner','editor'))
    WITH CHECK (current_user_role() IN ('owner','editor'));

CREATE POLICY validation_issues_select ON validation_issues FOR SELECT
    USING (current_user_role() IN ('owner','editor','viewer'));
CREATE POLICY validation_issues_update ON validation_issues FOR UPDATE
    USING (current_user_role() IN ('owner','editor'));

CREATE POLICY review_queue_select ON review_queue FOR SELECT
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY review_queue_update ON review_queue FOR UPDATE
    USING (current_user_role() IN ('owner','editor'));

CREATE POLICY conversations_owner ON conversations FOR ALL USING (current_user_role() = 'owner');
CREATE POLICY messages_owner ON messages FOR ALL USING (current_user_role() = 'owner');
CREATE POLICY escalations_owner ON escalations FOR ALL USING (current_user_role() = 'owner');

CREATE POLICY ai_training_select ON ai_training_data FOR SELECT
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY ai_training_write ON ai_training_data FOR ALL
    USING (current_user_role() = 'owner');

CREATE POLICY ai_cache_select ON ai_search_cache FOR SELECT
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY ai_usage_select ON ai_usage_log FOR SELECT
    USING (current_user_role() IN ('owner','editor'));

CREATE POLICY import_batches_select ON import_batches FOR SELECT
    USING (current_user_role() IN ('owner','editor'));
CREATE POLICY import_errors_select ON import_errors FOR SELECT
    USING (current_user_role() IN ('owner','editor'));

CREATE POLICY settings_select ON system_settings FOR SELECT
    USING (auth.role() = 'authenticated');
CREATE POLICY settings_update ON system_settings FOR ALL
    USING (current_user_role() = 'owner');

CREATE POLICY user_profiles_self_select ON user_profiles FOR SELECT
    USING (auth.uid() = id OR current_user_role() = 'owner');
CREATE POLICY user_profiles_owner_manage ON user_profiles FOR ALL
    USING (current_user_role() = 'owner');

-- ============================================================================
-- 006 — Seed Data
-- ============================================================================

INSERT INTO categories (id, name, code, name_ar, priority, display_order) VALUES
    (1,  'Korean Skincare',     'SKIN',    'العناية الكورية بالبشرة', 1,  1),
    (2,  'Thai Products',       'THAI',    'منتجات تايلندية',         2,  10),
    (3,  'Hair Care',           'HAIR',    'العناية بالشعر',          3,  3),
    (4,  'Makeup',              'MAKEUP',  'مكياج',                  4,  2),
    (5,  'Body Care',           'BODY',    'العناية بالجسم',          5,  4),
    (6,  'Perfumes',            'PERF',    'عطور',                   6,  5),
    (7,  'Beauty Tools',        'TOOL',    'أدوات التجميل',           7,  6),
    (8,  'Bags & Accessories',  'BAG',     'حقائب وإكسسوارات',       8,  7),
    (9,  'Gifts & Sets',        'GIFT',    'هدايا وأطقم',            9,  8),
    (10, 'Kids & Toys',         'KIDS',    'أطفال وألعاب',           10, 9),
    (11, 'Trending Products',   'TREND',   'منتجات رائجة',           99, 11);

SELECT setval('categories_id_seq', 11, true);

INSERT INTO sku_counter (prefix, sequence) VALUES
    ('SKIN', 0), ('THAI', 0), ('HAIR', 0), ('MAKEUP', 0), ('BODY', 0),
    ('PERF', 0), ('TOOL', 0), ('BAG', 0), ('GIFT', 0), ('KIDS', 0), ('TREND', 0);

INSERT INTO subcategories (category_id, name, name_ar, display_order) VALUES
    (1, 'Cleanser', 'غسول', 1),
    (1, 'Toner', 'تونر', 2),
    (1, 'Essence', 'إيسنس', 3),
    (1, 'Serum', 'سيروم', 4),
    (1, 'Moisturizer', 'كريم مرطب', 5),
    (1, 'Sunscreen', 'واقي شمس', 6),
    (1, 'Mask', 'ماسك', 7),
    (1, 'Eye Care', 'العناية بالعين', 8),
    (1, 'Lip Care', 'العناية بالشفاه', 9),
    (1, 'Toner Pad', 'باد التونر', 10),
    (4, 'Lipstick', 'أحمر شفاه', 1),
    (4, 'Lip Gloss', 'ملمع شفاه', 2),
    (4, 'Lip Tint', 'تنت شفاه', 3),
    (4, 'Foundation', 'كريم أساس', 4),
    (4, 'Concealer', 'كونسيلر', 5),
    (4, 'Powder', 'بودرة', 6),
    (4, 'Blush', 'بلاشر', 7),
    (4, 'Highlighter', 'هايلايتر', 8),
    (4, 'Bronzer', 'برونزر', 9),
    (4, 'Mascara', 'ماسكارا', 10),
    (4, 'Eyeshadow', 'ظلال عيون', 11),
    (4, 'Eyeliner', 'كحل', 12),
    (4, 'Eyebrow', 'حواجب', 13),
    (4, 'Primer', 'برايمر', 14),
    (4, 'Setting Spray', 'مثبت مكياج', 15),
    (3, 'Shampoo', 'شامبو', 1),
    (3, 'Conditioner', 'بلسم', 2),
    (3, 'Hair Oil', 'زيت شعر', 3),
    (3, 'Hair Mask', 'ماسك شعر', 4),
    (3, 'Scalp Serum', 'سيروم فروة', 5),
    (3, 'Heat Protectant', 'واقي حراري', 6),
    (5, 'Body Lotion', 'لوشن جسم', 1),
    (5, 'Body Mist', 'بخاخ جسم', 2),
    (5, 'Body Oil', 'زيت جسم', 3),
    (5, 'Body Scrub', 'مقشر جسم', 4),
    (5, 'Hand Cream', 'كريم يدين', 5),
    (5, 'Foot Cream', 'كريم قدمين', 6),
    (5, 'Deodorant', 'مزيل عرق', 7);

INSERT INTO brands (name, name_ar, code, country_origin) VALUES
    ('Medicube',            'ميديكيوب',        'MCB', 'South Korea'),
    ('Anua',                'انوا',           'ANU', 'South Korea'),
    ('COSRX',               'كوزركس',         'CRX', 'South Korea'),
    ('Beauty of Joseon',    'بيوتي اوف جوسون', 'BOJ', 'South Korea'),
    ('Skin1004',            'سكين 1004',      'SK4', 'South Korea'),
    ('Round Lab',           'راوند لاب',      'RLB', 'South Korea'),
    ('Axis-Y',              'اكسس واي',       'AXY', 'South Korea'),
    ('Numbuzin',            'نمبزن',          'NBZ', 'South Korea'),
    ('Torriden',            'توريدن',         'TRD', 'South Korea'),
    ('Some By Mi',          'سم باي مي',      'SBM', 'South Korea'),
    ('Isntree',             'إيزنتري',        'IST', 'South Korea'),
    ('Pyunkang Yul',        'بيونكانغ يول',   'PKY', 'South Korea'),
    ('Haruharu',            'هاروهارو',       'HRH', 'South Korea'),
    ('Klairs',              'كليرز',          'KLR', 'South Korea'),
    ('Iunik',               'يونيك',          'INK', 'South Korea'),
    ('Mixsoon',             'ميكسون',         'MXS', 'South Korea'),
    ('Tirtir',              'تيرتير',         'TRT', 'South Korea'),
    ('K18',                 'كي 18',          'K18', 'USA'),
    ('Olaplex',             'اولابليكس',      'OLP', 'USA'),
    ('Kerastase',           'كيراستاس',       'KRS', 'France'),
    ('Mistine',             'ميستين',         'MST', 'Thailand'),
    ('Snail White',         'سنيل وايت',      'SNW', 'Thailand');

INSERT INTO category_rules (brand_id, category_id, confidence)
SELECT b.id, 1, 1.00 FROM brands b
 WHERE b.name IN ('Medicube','Anua','COSRX','Beauty of Joseon','Skin1004',
                  'Round Lab','Axis-Y','Numbuzin','Torriden','Some By Mi',
                  'Isntree','Pyunkang Yul','Haruharu','Klairs','Iunik','Mixsoon','Tirtir');

INSERT INTO category_rules (brand_id, category_id, confidence)
SELECT b.id, 3, 1.00 FROM brands b WHERE b.name IN ('K18','Olaplex','Kerastase');

INSERT INTO category_rules (brand_id, category_id, confidence)
SELECT b.id, 2, 1.00 FROM brands b WHERE b.name IN ('Mistine','Snail White');

INSERT INTO keyword_rules (keyword, language, category_id, subcategory_id) VALUES
    ('cleanser','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Cleanser')),
    ('foam cleanser','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Cleanser')),
    ('cleansing balm','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Cleanser')),
    ('toner','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Toner')),
    ('toner pad','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Toner Pad')),
    ('essence','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Essence')),
    ('ampoule','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Essence')),
    ('serum','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Serum')),
    ('cream','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Moisturizer')),
    ('jelly cream','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Moisturizer')),
    ('moisturizer','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Moisturizer')),
    ('sunscreen','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Sunscreen')),
    ('sun stick','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Sunscreen')),
    ('sheet mask','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Mask')),
    ('sleeping mask','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Mask')),
    ('eye cream','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Eye Care')),
    ('eye patch','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Eye Care')),
    ('lip balm','en',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Lip Care')),
    ('lipstick','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Lipstick')),
    ('lip gloss','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Lip Gloss')),
    ('lip tint','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Lip Tint')),
    ('foundation','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Foundation')),
    ('concealer','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Concealer')),
    ('mascara','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Mascara')),
    ('eyeliner','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Eyeliner')),
    ('eyeshadow','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Eyeshadow')),
    ('blush','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Blush')),
    ('highlighter','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Highlighter')),
    ('primer','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Primer')),
    ('setting spray','en',4,(SELECT id FROM subcategories WHERE category_id=4 AND name='Setting Spray')),
    ('shampoo','en',3,(SELECT id FROM subcategories WHERE category_id=3 AND name='Shampoo')),
    ('conditioner','en',3,(SELECT id FROM subcategories WHERE category_id=3 AND name='Conditioner')),
    ('hair oil','en',3,(SELECT id FROM subcategories WHERE category_id=3 AND name='Hair Oil')),
    ('hair mask','en',3,(SELECT id FROM subcategories WHERE category_id=3 AND name='Hair Mask')),
    ('scalp serum','en',3,(SELECT id FROM subcategories WHERE category_id=3 AND name='Scalp Serum')),
    ('labubu','en',10,NULL),
    ('plushie','en',10,NULL),
    ('toy','en',10,NULL),
    ('gua sha','en',7,NULL),
    ('jade roller','en',7,NULL),
    ('derma pen','en',7,NULL),
    ('makeup brush','en',7,NULL),
    ('perfume','en',6,NULL),
    ('eau de parfum','en',6,NULL),
    ('gift set','en',9,NULL),
    ('bundle','en',9,NULL),
    ('combo','en',9,NULL),
    ('غسول','ar',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Cleanser')),
    ('تونر','ar',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Toner')),
    ('سيروم','ar',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Serum')),
    ('كريم','ar',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Moisturizer')),
    ('واقي شمس','ar',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Sunscreen')),
    ('ماسك','ar',1,(SELECT id FROM subcategories WHERE category_id=1 AND name='Mask'));

INSERT INTO system_settings (key, value, description) VALUES
    ('delivery_policy_en', '"Standard delivery: 1-3 days in Doha. Outside Doha: 2-5 days. Free delivery over QAR 200."'::jsonb, 'Delivery policy'),
    ('delivery_policy_ar', '"التوصيل القياسي: 1-3 أيام داخل الدوحة. خارج الدوحة: 2-5 أيام. توصيل مجاني للطلبات فوق 200 ريال."'::jsonb, 'Arabic delivery policy'),
    ('return_policy_en', '"Returns accepted within 7 days. Product must be unused, sealed, and in original packaging."'::jsonb, 'Return policy'),
    ('return_policy_ar', '"يتم قبول الإرجاع خلال 7 أيام. يجب أن يكون المنتج غير مستخدم ومغلق وفي عبوته الأصلية."'::jsonb, 'Arabic return policy'),
    ('low_stock_threshold', '5'::jsonb, 'Low stock alert threshold'),
    ('out_of_stock_threshold', '0'::jsonb, 'Out of stock threshold'),
    ('price_mismatch_threshold_pct', '15'::jsonb, 'Flag platform price drift threshold'),
    ('ai_confidence_threshold', '0.7'::jsonb, 'AI escalation threshold'),
    ('ai_cache_ttl_minutes', '60'::jsonb, 'Cache TTL'),
    ('match_threshold_auto', '85'::jsonb, 'Auto-link threshold'),
    ('match_threshold_review', '60'::jsonb, 'Review threshold'),
    ('refund_escalation_qar', '100'::jsonb, 'Refund escalation amount'),
    ('owner_whatsapp', '"+97400000000"'::jsonb, 'Owner WhatsApp number'),
    ('business_hours_start', '"08:00"'::jsonb, 'Business hours start'),
    ('business_hours_end', '"22:00"'::jsonb, 'Business hours end'),
    ('business_timezone', '"Asia/Qatar"'::jsonb, 'Timezone'),
    ('default_currency', '"QAR"'::jsonb, 'Currency'),
    ('image_min_dimensions', '{"width": 1200, "height": 1200}'::jsonb, 'Minimum image dimensions'),
    ('image_max_size_kb', '5120'::jsonb, 'Max image size');

-- ============================================================================
-- 007 — Analytics Views
-- ============================================================================

CREATE OR REPLACE VIEW v_products_full AS
SELECT p.id, p.master_sku, p.snoonu_sku, p.barcode,
       p.product_name_en, p.product_name_ar,
       b.name AS brand_name, b.name_ar AS brand_name_ar,
       c.name AS category_name, c.code AS category_code,
       sc.name AS subcategory_name,
       p.product_type, p.variant, p.size,
       p.price, p.discount_price,
       p.stock_quantity, p.stock_status, p.product_status,
       p.image_url, p.created_at, p.updated_at
FROM products p
JOIN brands b ON b.id = p.brand_id
JOIN categories c ON c.id = p.category_id
LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
WHERE p.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_dashboard_kpis AS
SELECT
    (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND product_status='active') AS active_products,
    (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND product_status='draft') AS draft_products,
    (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL AND stock_quantity <= 5 AND product_status='active') AS low_stock_count,
    (SELECT COUNT(*) FROM validation_issues WHERE status='open' AND severity='critical') AS open_critical_validations,
    (SELECT COUNT(*) FROM review_queue WHERE status='pending') AS pending_reviews,
    (SELECT COUNT(*) FROM escalations WHERE status='open') AS open_escalations;

-- ============================================================================
-- 009 — Search RPC Functions
-- ============================================================================

CREATE OR REPLACE FUNCTION search_products_exact(p_query TEXT)
RETURNS TABLE (
    master_sku TEXT, product_name_en TEXT, product_name_ar TEXT,
    brand_id INTEGER, category_id INTEGER, price NUMERIC,
    discount_price NUMERIC, stock_quantity INTEGER, stock_status TEXT,
    image_url TEXT, match_type TEXT
) AS $$
    SELECT p.master_sku, p.product_name_en, p.product_name_ar,
           p.brand_id, p.category_id, p.price, p.discount_price,
           p.stock_quantity, p.stock_status, p.image_url, 'master_sku'::TEXT
      FROM products p
     WHERE p.master_sku = p_query AND p.deleted_at IS NULL LIMIT 1
    UNION ALL
    SELECT p.master_sku, p.product_name_en, p.product_name_ar,
           p.brand_id, p.category_id, p.price, p.discount_price,
           p.stock_quantity, p.stock_status, p.image_url, 'barcode'::TEXT
      FROM products p
     WHERE p.barcode = p_query AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM products WHERE master_sku = p_query) LIMIT 1
    UNION ALL
    SELECT p.master_sku, p.product_name_en, p.product_name_ar,
           p.brand_id, p.category_id, p.price, p.discount_price,
           p.stock_quantity, p.stock_status, p.image_url, 'snoonu_sku'::TEXT
      FROM products p
     WHERE p.snoonu_sku = p_query AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM products WHERE master_sku = p_query OR barcode = p_query) LIMIT 1
    UNION ALL
    SELECT p.master_sku, p.product_name_en, p.product_name_ar,
           p.brand_id, p.category_id, p.price, p.discount_price,
           p.stock_quantity, p.stock_status, p.image_url,
           ('platform_' || pm.platform)::TEXT
      FROM products p
      JOIN platform_mappings pm ON pm.master_sku = p.master_sku
     WHERE pm.platform_sku = p_query AND p.deleted_at IS NULL LIMIT 1;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION search_products_fuzzy(
    p_query TEXT, p_threshold NUMERIC DEFAULT 0.3, p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    master_sku TEXT, product_name_en TEXT, product_name_ar TEXT,
    brand_id INTEGER, category_id INTEGER, price NUMERIC,
    stock_quantity INTEGER, image_url TEXT, score NUMERIC
) AS $$
    SELECT p.master_sku, p.product_name_en, p.product_name_ar,
           p.brand_id, p.category_id, p.price, p.stock_quantity, p.image_url,
           GREATEST(
               similarity(p.product_name_en, p_query),
               similarity(COALESCE(p.product_name_ar, ''), p_query)
           )::NUMERIC AS score
    FROM products p
    WHERE p.deleted_at IS NULL AND p.product_status = 'active'
      AND (p.product_name_en % p_query OR p.product_name_ar % p_query)
    ORDER BY score DESC LIMIT p_limit;
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION search_products(
    p_query TEXT, p_embedding VECTOR(1536) DEFAULT NULL, p_limit INTEGER DEFAULT 5
)
RETURNS TABLE (
    master_sku TEXT, product_name_en TEXT, product_name_ar TEXT,
    price NUMERIC, stock_quantity INTEGER, image_url TEXT,
    score NUMERIC, tier TEXT
) AS $$
DECLARE
    exact_count INTEGER;
BEGIN
    RETURN QUERY
        SELECT e.master_sku, e.product_name_en, e.product_name_ar,
               e.price, e.stock_quantity, e.image_url,
               1.0::NUMERIC, ('exact:' || e.match_type)::TEXT
          FROM search_products_exact(p_query) e LIMIT p_limit;
    GET DIAGNOSTICS exact_count = ROW_COUNT;
    IF exact_count > 0 THEN RETURN; END IF;

    RETURN QUERY
        SELECT f.master_sku, f.product_name_en, f.product_name_ar,
               f.price, f.stock_quantity, f.image_url, f.score, 'fuzzy'::TEXT
          FROM search_products_fuzzy(p_query, 0.3, p_limit) f;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION find_duplicate_candidates(
    p_master_sku TEXT, p_threshold NUMERIC DEFAULT 0.7
)
RETURNS TABLE (
    candidate_sku TEXT, candidate_name TEXT,
    name_similarity NUMERIC, same_brand BOOLEAN,
    same_size BOOLEAN, barcode_match BOOLEAN
) AS $$
DECLARE src RECORD;
BEGIN
    SELECT product_name_en, brand_id, size, barcode INTO src
      FROM products WHERE master_sku = p_master_sku;
    IF NOT FOUND THEN RETURN; END IF;

    RETURN QUERY
    SELECT p.master_sku, p.product_name_en,
           similarity(p.product_name_en, src.product_name_en)::NUMERIC,
           (p.brand_id = src.brand_id),
           (p.size = src.size OR (p.size IS NULL AND src.size IS NULL)),
           (p.barcode = src.barcode AND p.barcode IS NOT NULL)
    FROM products p
    WHERE p.master_sku <> p_master_sku AND p.deleted_at IS NULL
      AND (p.barcode = src.barcode
           OR (p.brand_id = src.brand_id
               AND similarity(p.product_name_en, src.product_name_en) >= p_threshold))
    ORDER BY (p.barcode = src.barcode AND p.barcode IS NOT NULL) DESC,
             similarity(p.product_name_en, src.product_name_en) DESC LIMIT 10;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================================
-- DONE. Verify in Supabase Table Editor: should see 24 tables.
-- ============================================================================
