-- ============================================================================
-- MIGRATION 0026 — Bulk AI Recovery: atomic, idempotent recovery RPC
-- ----------------------------------------------------------------------------
-- Replaces the app-side "claim + insert + finalize" dance (recovered_at + TTL)
-- with ONE transactional function so that converting an ai_draft into a product
-- and marking the draft recovered is all-or-nothing and duplicate-proof.
--
-- Why this is needed:
--   products.master_sku is minted by the BEFORE INSERT trigger
--   trg_products_assign_sku on every insert (MK-<CATEGORY>-<NNNN>), so it can
--   never be a deterministic idempotency key. Without a single transaction, a
--   finalize failure (or a lost HTTP response) followed by a retry inserts a
--   SECOND product with a fresh SKU — the UNIQUE(master_sku) index cannot catch
--   it. Locking the draft row FOR UPDATE + re-checking status inside one
--   transaction removes that race entirely.
--
-- Guarantees:
--   * FOR UPDATE serializes concurrent recoveries of the same draft.
--   * Already-recovered drafts return the existing product; no new insert.
--   * INSERT products + UPDATE ai_drafts run in the SAME transaction — any
--     error rolls back BOTH (no orphan product, no partial finalize).
--   * The payload can NOT set id / master_sku / created_at / updated_at /
--     created_by / updated_by (explicit column list; audit fields set here).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recover_ai_draft(
  p_draft_id        bigint,
  p_actor_id        uuid,
  p_actor_email     text,
  p_product_payload jsonb
)
RETURNS TABLE (
  already_recovered boolean,
  product_id        bigint,
  master_sku        text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_draft      public.ai_drafts%ROWTYPE;
  v_product_id bigint;
  v_master_sku text;
BEGIN
  -- 1. Lock the draft row for the whole transaction (serializes concurrency).
  SELECT * INTO v_draft
    FROM public.ai_drafts
   WHERE id = p_draft_id
     FOR UPDATE;

  -- 2. Missing draft.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRAFT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- 3. Idempotent: already recovered → return the existing product, no insert.
  IF v_draft.status = 'recovered' THEN
    SELECT p.id, p.master_sku
      INTO v_product_id, v_master_sku
      FROM public.products p
     WHERE p.master_sku = v_draft.recovered_master_sku;
    -- product_id may be NULL if the recovered product was later deleted
    -- (recovered_master_sku FK is ON DELETE SET NULL) — caller flags this.
    RETURN QUERY SELECT true, v_product_id, v_draft.recovered_master_sku;
    RETURN;
  END IF;

  -- 4. Only pending drafts may be recovered.
  IF v_draft.status <> 'pending_recovery' THEN
    RAISE EXCEPTION 'DRAFT_NOT_RECOVERABLE:%', v_draft.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- 5. Insert the product with an EXPLICIT column list. master_sku is
  --    intentionally omitted so trg_products_assign_sku mints MK-<CAT>-<NNNN>.
  --    id / created_at / updated_at are DB-managed; created_by / updated_by are
  --    forced to the actor here (never taken from the payload).
  INSERT INTO public.products (
    product_name_en, product_name_ar,
    brand_id, category_id, subcategory_id,
    product_type, variant, color, size,
    price, stock_quantity, stock_status, product_status,
    description_en, description_ar, usage_en, usage_ar,
    keywords_en, keywords_ar,
    source_platform, image_url, image_filename,
    ai_generated, ai_confidence, ai_meta,
    created_by, updated_by
  )
  VALUES (
    p_product_payload->>'product_name_en',
    p_product_payload->>'product_name_ar',
    (p_product_payload->>'brand_id')::int,
    (p_product_payload->>'category_id')::int,
    NULLIF(p_product_payload->>'subcategory_id', '')::int,
    p_product_payload->>'product_type',
    p_product_payload->>'variant',
    p_product_payload->>'color',
    p_product_payload->>'size',
    COALESCE((p_product_payload->>'price')::numeric, 0),
    COALESCE((p_product_payload->>'stock_quantity')::int, 0),
    COALESCE(p_product_payload->>'stock_status', 'out_of_stock'),
    COALESCE(p_product_payload->>'product_status', 'draft'),
    p_product_payload->>'description_en',
    p_product_payload->>'description_ar',
    p_product_payload->>'usage_en',
    p_product_payload->>'usage_ar',
    CASE WHEN p_product_payload ? 'keywords_en' AND jsonb_typeof(p_product_payload->'keywords_en') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_product_payload->'keywords_en')) END,
    CASE WHEN p_product_payload ? 'keywords_ar' AND jsonb_typeof(p_product_payload->'keywords_ar') = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(p_product_payload->'keywords_ar')) END,
    COALESCE(p_product_payload->>'source_platform', 'manual'),
    p_product_payload->>'image_url',
    p_product_payload->>'image_filename',
    COALESCE((p_product_payload->>'ai_generated')::boolean, true),
    (p_product_payload->>'ai_confidence')::numeric,
    COALESCE(p_product_payload->'ai_meta', '{}'::jsonb),
    -- Audit fields are forced here (NEVER taken from the JSON payload): the
    -- actor email is the normal value; the actor UUID is only a fallback.
    COALESCE(NULLIF(btrim(p_actor_email), ''), p_actor_id::text),
    COALESCE(NULLIF(btrim(p_actor_email), ''), p_actor_id::text)
  )
  RETURNING id, products.master_sku
       INTO v_product_id, v_master_sku;

  -- 6. Finalize the draft in the SAME transaction. If this fails, the product
  --    insert above rolls back too (no orphan, no partial finalize).
  UPDATE public.ai_drafts
     SET status               = 'recovered',
         recovered_at         = now(),
         recovered_master_sku = v_master_sku
   WHERE id = p_draft_id;

  RETURN QUERY SELECT false, v_product_id, v_master_sku;
END;
$$;

-- ============================================================================
-- ACL — service_role only (called via the server admin client). Never expose
-- this SECURITY DEFINER function to anon / authenticated.
-- ============================================================================
REVOKE ALL ON FUNCTION public.recover_ai_draft(bigint, uuid, text, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.recover_ai_draft(bigint, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.recover_ai_draft(bigint, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recover_ai_draft(bigint, uuid, text, jsonb) TO service_role;
