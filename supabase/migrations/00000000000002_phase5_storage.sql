-- ============================================================================
-- PHASE 5 — Supabase Storage bucket + Internal barcode generator
-- ============================================================================
-- Run once in Supabase Dashboard → SQL Editor → New query → Paste → Run
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Create product-images storage bucket
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'product-images',
    'product-images',
    true,
    5242880,  -- 5 MB
    ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
)
ON CONFLICT (id) DO UPDATE
   SET public = EXCLUDED.public,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ----------------------------------------------------------------------------
-- 2. Storage RLS policies
-- ----------------------------------------------------------------------------

-- Public read (anyone with the URL can view product images)
DROP POLICY IF EXISTS "Public read product images" ON storage.objects;
CREATE POLICY "Public read product images"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'product-images');

-- Authenticated users (any role) can upload
DROP POLICY IF EXISTS "Auth upload product images" ON storage.objects;
CREATE POLICY "Auth upload product images"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'product-images'
        AND auth.role() = 'authenticated'
    );

-- Authenticated users (owner/editor) can update (replace) images
DROP POLICY IF EXISTS "Auth update product images" ON storage.objects;
CREATE POLICY "Auth update product images"
    ON storage.objects FOR UPDATE
    USING (
        bucket_id = 'product-images'
        AND auth.role() = 'authenticated'
    );

-- Owner only can delete
DROP POLICY IF EXISTS "Owner delete product images" ON storage.objects;
CREATE POLICY "Owner delete product images"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'product-images'
        AND EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid() AND role = 'owner'
        )
    );

-- ----------------------------------------------------------------------------
-- 3. Internal barcode generator (EAN-13 with Qatar prefix 629)
-- ----------------------------------------------------------------------------
-- Use ONLY when manufacturer barcode is missing.
-- Format: 629 + 9-digit sequence + EAN-13 check digit (total 13 digits)

CREATE OR REPLACE FUNCTION generate_internal_barcode()
RETURNS TEXT AS $$
DECLARE
    seq         BIGINT;
    base12      TEXT;
    check_digit INT;
    i           INT;
    digit       INT;
    sum_total   INT := 0;
BEGIN
    -- Allocate next sequence (transactional)
    INSERT INTO sku_counter(prefix, sequence)
    VALUES ('BARCODE', 0)
    ON CONFLICT (prefix) DO NOTHING;

    UPDATE sku_counter
       SET sequence = sequence + 1, updated_at = NOW()
     WHERE prefix = 'BARCODE'
    RETURNING sequence INTO seq;

    -- Build first 12 digits: 629 (unofficial Qatar prefix) + 9-digit padded seq
    base12 := '629' || LPAD(seq::TEXT, 9, '0');

    -- EAN-13 check digit: odd positions ×1, even positions ×3 from left (1-indexed)
    FOR i IN 1..12 LOOP
        digit := SUBSTRING(base12, i, 1)::INT;
        IF i % 2 = 1 THEN
            sum_total := sum_total + digit;
        ELSE
            sum_total := sum_total + digit * 3;
        END IF;
    END LOOP;
    check_digit := (10 - (sum_total % 10)) % 10;

    RETURN base12 || check_digit::TEXT;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_internal_barcode() IS
    'Generates a unique 13-digit EAN-13 internal barcode. Use only when manufacturer EAN/UPC is unavailable. Prefix 629 (unofficial Qatar).';

-- ----------------------------------------------------------------------------
-- 4. Verify
-- ----------------------------------------------------------------------------
-- Run: SELECT generate_internal_barcode();
-- Should return something like "6290000000016" each call (unique).
