-- ============================================================================
-- MIGRATION 0014 — Phase 13B hardening: finding self-contained snapshots
-- ============================================================================
-- Every reconciliation_finding now carries its own baseline + target product
-- snapshot so the row is fully renderable even if:
--   - the joined platform_products row is deleted (audit-style records)
--   - the join is omitted by callers
--   - the underlying import is purged
--
-- Snapshot shape (JSON):
--   {
--     "platform": "snoonu",
--     "product_id": 1234,
--     "name_en": "...",
--     "name_ar": "...",
--     "normalized_name": "...",
--     "source_sku": "...",
--     "matched_master_sku": "...",
--     "barcode": "...",
--     "brand": "...",
--     "category": "...",
--     "variant_color": "...",
--     "variant_size": "...",
--     "variant_pack": 3,
--     "image_url": "...",
--     "image_filename": "...",
--     "price": 50.00,
--     "discount_price": null,
--     "stock_quantity": 10,
--     "stock_status": "in_stock",
--     "platform_status": "active"
--   }
--
-- Idempotent — safe to re-run.
-- ============================================================================

ALTER TABLE reconciliation_findings
    ADD COLUMN IF NOT EXISTS baseline_snapshot  JSONB,
    ADD COLUMN IF NOT EXISTS target_snapshot    JSONB,
    ADD COLUMN IF NOT EXISTS matching_reason    TEXT;

COMMENT ON COLUMN reconciliation_findings.baseline_snapshot
    IS 'Phase 13B.9: full Snoonu product snapshot at comparator time. Null only when baseline truly does not exist (i.e. missing_on_baseline findings).';
COMMENT ON COLUMN reconciliation_findings.target_snapshot
    IS 'Phase 13B.9: full target-platform product snapshot at comparator time. Null only when target truly does not exist (i.e. missing_on_target findings).';
COMMENT ON COLUMN reconciliation_findings.matching_reason
    IS 'Phase 13B.9: short string explaining why this finding was emitted — e.g. "sku_exact", "fuzzy:0.91", "variant_family:color", "stock_bucket_diff".';

-- Indexes for filtering on missing-snapshot rows (data quality dashboard)
CREATE INDEX IF NOT EXISTS idx_findings_baseline_snap_present
    ON reconciliation_findings ((baseline_snapshot IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_findings_target_snap_present
    ON reconciliation_findings ((target_snapshot IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_findings_matching_reason
    ON reconciliation_findings (matching_reason)
    WHERE matching_reason IS NOT NULL;

-- ============================================================================
-- End of migration 0014
-- ============================================================================
