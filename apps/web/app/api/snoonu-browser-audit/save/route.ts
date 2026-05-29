/**
 * POST /api/snoonu-browser-audit/save
 *
 * Accepts a Snoonu browser snapshot (from Chrome MCP read or operator paste)
 * and saves it into snoonu_browser_audits. Sets audit_status='audited'.
 *
 * Body (one of):
 *   { product_id, snapshot: SnoonuBrowserSnapshot }
 *     → use existing audit row or create one
 *   { audit_id, snapshot: SnoonuBrowserSnapshot }
 *     → update specific audit row
 *
 * Returns: { audit_id, extracted, confidence }
 *
 * READ-ONLY guarantee: this only writes to our own snoonu_browser_audits
 * table. It never sends data back to Snoonu.
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

const SnapshotSchema = z.object({
  page_text: z.string().optional(),
  page_title: z.string().nullable().optional(),
  page_url: z.string().url().nullable().optional(),
  breadcrumb: z.array(z.string()).optional(),
  listed_categories: z.array(z.string()).optional(),
  branches: z.array(z.object({
    name: z.string(),
    stock: z.union([z.string(), z.number()]).nullable().optional(),
    price: z.union([z.string(), z.number()]).nullable().optional(),
    available: z.boolean().nullable().optional(),
  })).optional(),
  product_id_field: z.string().nullable().optional(),
  product_name_field: z.string().nullable().optional(),
  product_name_ar_field: z.string().nullable().optional(),
  category_field: z.string().nullable().optional(),
  subcategory_field: z.string().nullable().optional(),
  section_field: z.string().nullable().optional(),
  catalog_field: z.string().nullable().optional(),
  price_field: z.union([z.string(), z.number()]).nullable().optional(),
  discount_field: z.union([z.string(), z.number()]).nullable().optional(),
  stock_field: z.union([z.string(), z.number()]).nullable().optional(),
  status_field: z.string().nullable().optional(),
  image_url_field: z.string().nullable().optional(),
  option_groups_raw: z.array(z.any()).optional(),
  variants_raw: z.array(z.any()).optional(),
}).passthrough();

const BodySchema = z.union([
  z.object({
    product_id: z.number().int(),
    snapshot: SnapshotSchema,
  }),
  z.object({
    audit_id: z.number().int(),
    snapshot: SnapshotSchema,
  }),
]);

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = BodySchema.parse(await req.json());
  const snapshot = body.snapshot as SnoonuBrowserSnapshot;

  if (!snapshotIsUsable(snapshot)) {
    return err(
      'SNAPSHOT_EMPTY',
      'The browser snapshot has no usable fields. Make sure you captured the Snoonu product page.',
      400,
    );
  }

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // Resolve audit row + product_id + import_id
  let auditId: number | null = null;
  let productId: number;
  let importId: number | null = null;

  if ('audit_id' in body) {
    const { data: existing } = await admin
      .from('snoonu_browser_audits')
      .select('id, product_id, import_id')
      .eq('id', body.audit_id)
      .maybeSingle();
    if (!existing) return err('AUDIT_NOT_FOUND', `Audit ${body.audit_id} not found`, 404);
    const row = existing as { id: number; product_id: number; import_id: number | null };
    auditId = row.id;
    productId = row.product_id;
    importId = row.import_id;
  } else {
    productId = body.product_id;
    const { data: product } = await admin
      .from('platform_products')
      .select('id, import_id, platform')
      .eq('id', productId)
      .maybeSingle();
    if (!product) return err('PRODUCT_NOT_FOUND', `platform_products ${productId} not found`, 404);
    const p = product as { id: number; import_id: number; platform: string };
    if (p.platform !== 'snoonu') {
      return err('NOT_SNOONU_PRODUCT', 'Browser audits only apply to Snoonu products', 400);
    }
    importId = p.import_id;
  }

  // Extract structured data
  const extracted = extractProductData(snapshot);

  // Upsert audit row
  const auditRow = {
    product_id: productId,
    import_id: importId,
    snoonu_product_url: extracted.snoonu_product_url,
    snoonu_product_id: extracted.snoonu_product_id,
    snoonu_product_name: extracted.snoonu_product_name,
    snoonu_name_ar: extracted.snoonu_name_ar,
    snoonu_catalog: extracted.snoonu_catalog,
    snoonu_category: extracted.snoonu_category,
    snoonu_subcategory: extracted.snoonu_subcategory,
    snoonu_section: extracted.snoonu_section,
    snoonu_menu_path: extracted.snoonu_menu_path,
    snoonu_price: extracted.snoonu_price,
    snoonu_discount_price: extracted.snoonu_discount_price,
    snoonu_currency: extracted.snoonu_currency,
    snoonu_stock: extracted.snoonu_stock,
    snoonu_status: extracted.snoonu_status,
    snoonu_is_visible: extracted.snoonu_is_visible,
    snoonu_image_url: extracted.snoonu_image_url,
    snoonu_image_filename: extracted.snoonu_image_filename,
    has_options: extracted.has_options,
    option_groups: extracted.option_groups,
    variants: extracted.variants,
    // Phase 13E.13 — new fields
    snoonu_branches: extracted.branches,
    snoonu_secondary_categories: extracted.snoonu_secondary_categories,
    raw_browser_snapshot: snapshot,
    audit_status: 'audited' as const,
    audit_confidence: extracted.confidence,
    audited_at: new Date().toISOString(),
    audited_by: user.id,
  };

  let savedId: number;
  if (auditId) {
    const { error: updErr } = await admin
      .from('snoonu_browser_audits')
      .update(auditRow)
      .eq('id', auditId);
    if (updErr) return err('AUDIT_UPDATE_FAILED', updErr.message, 500);
    savedId = auditId;
  } else {
    // Look for an existing audit for the same (product, url) so we re-use it
    const { data: priorAudit } = await admin
      .from('snoonu_browser_audits')
      .select('id')
      .eq('product_id', productId)
      .eq('snoonu_product_url', extracted.snoonu_product_url ?? '')
      .maybeSingle();
    if (priorAudit) {
      const pid = (priorAudit as { id: number }).id;
      const { error: updErr } = await admin
        .from('snoonu_browser_audits')
        .update(auditRow)
        .eq('id', pid);
      if (updErr) return err('AUDIT_UPDATE_FAILED', updErr.message, 500);
      savedId = pid;
    } else {
      const { data: inserted, error: insErr } = await admin
        .from('snoonu_browser_audits')
        .insert(auditRow)
        .select('id')
        .single();
      if (insErr) return err('AUDIT_INSERT_FAILED', insErr.message, 500);
      savedId = (inserted as { id: number }).id;
    }
  }

  return ok({
    audit_id: savedId,
    product_id: productId,
    extracted,
    confidence: extracted.confidence,
    extraction_notes: extracted.extraction_notes,
  });
});
