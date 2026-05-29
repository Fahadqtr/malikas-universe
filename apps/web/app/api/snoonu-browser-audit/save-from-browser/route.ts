/**
 * POST /api/snoonu-browser-audit/save-from-browser
 *
 * One-shot endpoint for browser automation runs: takes a full snapshot and a
 * queue product reference, validates the match, then EITHER auto-applies
 * (confidence >= 0.95) or saves as needs_review.
 *
 * Body:
 *   {
 *     product_id: number,          // platform_products.id from the audit queue
 *     snapshot: SnoonuBrowserSnapshot,
 *     queue_product_name?: string  // optional: helps validate match if name differs
 *   }
 *
 * Auto-apply rules:
 *   - confidence >= 0.95 AND product names overlap meaningfully → save + apply
 *   - confidence in 0.75..0.95 → save as audited (operator review)
 *   - confidence < 0.75       → save as needs_review with low_confidence flag
 *
 * READ-ONLY guarantee: only writes to our DB. Never POSTs to Snoonu.
 *
 * Returns:
 *   {
 *     audit_id,
 *     auto_applied: boolean,
 *     audit_status: 'verified' | 'audited' | 'needs_review',
 *     confidence,
 *     match_reason: string,
 *     extracted: ExtractedProductData
 *   }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import {
  extractProductData,
  snapshotIsUsable,
  type SnoonuBrowserSnapshot,
} from '@/lib/reconciliation/snoonu-browser-extractor';

export const runtime = 'nodejs';
export const maxDuration = 60;

const AUTO_APPLY_THRESHOLD = 0.95;
const NEEDS_REVIEW_THRESHOLD = 0.75;

const Schema = z.object({
  product_id: z.number().int(),
  queue_product_name: z.string().optional(),
  snapshot: z.any(),
});

function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Token-set Jaccard similarity. */
function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = new Set(normalize(a).split(' ').filter((t) => t.length > 1));
  const tb = new Set(normalize(b).split(' ').filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());
  const snapshot = body.snapshot as SnoonuBrowserSnapshot;

  if (!snapshotIsUsable(snapshot)) {
    return err('SNAPSHOT_EMPTY', 'Snapshot has no usable fields', 400);
  }

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // Resolve queue product (we need it to validate the name match)
  const { data: product } = await admin
    .from('platform_products')
    .select('id, import_id, platform, source_sku, name_en, name_ar, normalized_name, price')
    .eq('id', body.product_id)
    .maybeSingle();
  if (!product) return err('PRODUCT_NOT_FOUND', `platform_products ${body.product_id} not found`, 404);
  const p = product as {
    id: number;
    import_id: number;
    platform: string;
    source_sku: string | null;
    name_en: string | null;
    name_ar: string | null;
    normalized_name: string | null;
    price: number | null;
  };
  if (p.platform !== 'snoonu') {
    return err('NOT_SNOONU_PRODUCT', 'Browser audits only apply to Snoonu products', 400);
  }

  // Extract structured data
  const extracted = extractProductData(snapshot);

  // ─── Match validation ──────────────────────────────────────────────────
  const queueName = body.queue_product_name ?? p.name_en ?? p.normalized_name;
  const nameSim = nameSimilarity(queueName, extracted.snoonu_product_name);
  const priceClose =
    p.price != null && extracted.snoonu_price != null
      ? Math.abs(p.price - extracted.snoonu_price) / Math.max(p.price, extracted.snoonu_price) < 0.05
      : null;

  // Blend extraction confidence with name similarity (and price hint when present)
  const matchSignal = nameSim;
  const priceBoost = priceClose === true ? 0.05 : 0;
  const finalConfidence = Math.min(1, extracted.confidence * 0.7 + matchSignal * 0.3 + priceBoost);

  const matchReasonParts: string[] = [];
  matchReasonParts.push(`extract_conf:${extracted.confidence.toFixed(2)}`);
  matchReasonParts.push(`name_sim:${nameSim.toFixed(2)}`);
  if (priceClose === true) matchReasonParts.push('price_match');
  else if (priceClose === false) matchReasonParts.push('price_diverges');
  const matchReason = matchReasonParts.join(' · ');

  // ─── Upsert audit row ──────────────────────────────────────────────────
  const auditRow = {
    product_id: p.id,
    import_id: p.import_id,
    snoonu_product_url: extracted.snoonu_product_url,
    snoonu_product_id: extracted.snoonu_product_id,
    snoonu_product_name: extracted.snoonu_product_name,
    snoonu_name_ar: extracted.snoonu_name_ar,
    snoonu_catalog: extracted.snoonu_catalog,
    snoonu_category: extracted.snoonu_category,
    snoonu_subcategory: extracted.snoonu_subcategory,
    snoonu_section: extracted.snoonu_section,
    snoonu_menu_path: extracted.snoonu_menu_path,
    snoonu_secondary_categories: extracted.snoonu_secondary_categories,
    snoonu_price: extracted.snoonu_price,
    snoonu_discount_price: extracted.snoonu_discount_price,
    snoonu_currency: extracted.snoonu_currency,
    snoonu_stock: extracted.snoonu_stock,
    snoonu_status: extracted.snoonu_status,
    snoonu_is_visible: extracted.snoonu_is_visible,
    snoonu_image_url: extracted.snoonu_image_url,
    snoonu_image_filename: extracted.snoonu_image_filename,
    snoonu_branches: extracted.branches,
    has_options: extracted.has_options,
    option_groups: extracted.option_groups,
    variants: extracted.variants,
    raw_browser_snapshot: snapshot,
    audit_status: 'audited' as const,
    audit_confidence: finalConfidence,
    audited_at: new Date().toISOString(),
    audited_by: user.id,
    audit_notes: matchReason,
  };

  // Look for existing audit row (product_id is unique enough since each
  // platform_products row maps 1:1 to a Snoonu product)
  const { data: existing } = await admin
    .from('snoonu_browser_audits')
    .select('id')
    .eq('product_id', p.id)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  let savedId: number;
  if (existing) {
    const eid = (existing as { id: number }).id;
    const { error: updErr } = await admin
      .from('snoonu_browser_audits')
      .update(auditRow)
      .eq('id', eid);
    if (updErr) return err('AUDIT_UPDATE_FAILED', updErr.message, 500);
    savedId = eid;
  } else {
    const { data: inserted, error: insErr } = await admin
      .from('snoonu_browser_audits')
      .insert(auditRow)
      .select('id')
      .single();
    if (insErr) return err('AUDIT_INSERT_FAILED', insErr.message, 500);
    savedId = (inserted as { id: number }).id;
  }

  // ─── Auto-apply gate ───────────────────────────────────────────────────
  let autoApplied = false;
  let auditStatus: 'verified' | 'audited' | 'needs_review' = 'audited';

  if (finalConfidence >= AUTO_APPLY_THRESHOLD) {
    // Build platform_products update payload directly (replicates apply logic)
    const ppUpdate: Record<string, unknown> = {};
    if (extracted.snoonu_catalog) ppUpdate.snoonu_catalog = extracted.snoonu_catalog;
    if (extracted.snoonu_category) ppUpdate.snoonu_category = extracted.snoonu_category;
    if (extracted.snoonu_subcategory) ppUpdate.snoonu_subcategory = extracted.snoonu_subcategory;
    if (extracted.snoonu_section) ppUpdate.snoonu_section = extracted.snoonu_section;
    if (extracted.snoonu_menu_path) ppUpdate.snoonu_menu_path = extracted.snoonu_menu_path;
    if (extracted.snoonu_secondary_categories.length > 0) {
      ppUpdate.snoonu_secondary_categories = extracted.snoonu_secondary_categories;
    }
    if (extracted.snoonu_product_url) ppUpdate.snoonu_catalog_source_url = extracted.snoonu_product_url;
    ppUpdate.catalog_source = 'browser_read';
    ppUpdate.catalog_confidence = 1.0;
    ppUpdate.catalog_checked_at = new Date().toISOString();
    if (extracted.snoonu_price != null) ppUpdate.price = extracted.snoonu_price;
    if (extracted.snoonu_discount_price != null) ppUpdate.discount_price = extracted.snoonu_discount_price;
    if (extracted.snoonu_stock != null) ppUpdate.stock_quantity = extracted.snoonu_stock;
    if (extracted.branches.length > 0) ppUpdate.snoonu_branches = extracted.branches;
    if (extracted.snoonu_status) ppUpdate.platform_status = extracted.snoonu_status;
    if (extracted.snoonu_image_url) ppUpdate.image_url = extracted.snoonu_image_url;
    if (extracted.snoonu_image_filename) ppUpdate.image_filename = extracted.snoonu_image_filename;
    if (extracted.snoonu_product_name) ppUpdate.name_en = extracted.snoonu_product_name;
    if (extracted.snoonu_name_ar) ppUpdate.name_ar = extracted.snoonu_name_ar;

    await admin.from('platform_products').update(ppUpdate).eq('id', p.id);

    await admin
      .from('snoonu_browser_audits')
      .update({
        audit_status: 'verified',
        applied_at: new Date().toISOString(),
        applied_fields: ['catalog', 'price', 'stock', 'status', 'image', 'name', 'branches'],
        verified_at: new Date().toISOString(),
        verified_by: user.id,
      })
      .eq('id', savedId);

    autoApplied = true;
    auditStatus = 'verified';
  } else if (finalConfidence < NEEDS_REVIEW_THRESHOLD) {
    auditStatus = 'needs_review';
    // Mark in audit row but keep the 'audited' lifecycle status — audit_status
    // CHECK doesn't include 'needs_review', so we just keep 'audited' and let
    // the operator filter by low confidence.
  }

  return ok({
    audit_id: savedId,
    auto_applied: autoApplied,
    audit_status: auditStatus,
    confidence: finalConfidence,
    name_similarity: nameSim,
    price_match: priceClose,
    match_reason: matchReason,
    extracted,
  });
});
