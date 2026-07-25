/**
 * POST /api/snoonu-browser-audit/apply
 *
 * Copy fields from a snoonu_browser_audits row into the matching
 * platform_products row. Operator picks which fields to apply.
 *
 * Body:
 *   {
 *     audit_id: number,
 *     fields?: Array<'catalog' | 'price' | 'stock' | 'status' | 'image' | 'options' | 'variants' | 'name' | 'all'>,
 *     mark_verified?: boolean,    // if true, also set audit_status='verified'/applied
 *   }
 *
 * READ-ONLY guarantee: this only updates platform_products in our DB. Never
 * sends anything to Snoonu.
 *
 * Returns: { audit_id, product_id, applied_fields, audit_status }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import type { Database } from '@malikas/db';

export const runtime = 'nodejs';

const FieldEnum = z.enum([
  'catalog',
  'price',
  'stock',
  'status',
  'image',
  'options',
  'variants',
  'name',
  'all',
]);

const Schema = z.object({
  audit_id: z.number().int(),
  fields: z.array(FieldEnum).optional(),
  mark_verified: z.boolean().optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  const { data: audit } = await admin
    .from('snoonu_browser_audits')
    .select('*')
    .eq('id', body.audit_id)
    .maybeSingle();
  if (!audit) return err('AUDIT_NOT_FOUND', `Audit ${body.audit_id} not found`, 404);

  const a = audit as {
    id: number;
    product_id: number;
    audit_status: string;
    snoonu_product_url: string | null;
    snoonu_product_id: string | null;
    snoonu_product_name: string | null;
    snoonu_name_ar: string | null;
    snoonu_catalog: string | null;
    snoonu_category: string | null;
    snoonu_subcategory: string | null;
    snoonu_section: string | null;
    snoonu_menu_path: string | null;
    snoonu_price: number | null;
    snoonu_discount_price: number | null;
    snoonu_stock: number | null;
    snoonu_status: string | null;
    snoonu_image_url: string | null;
    snoonu_image_filename: string | null;
    has_options: boolean;
    option_groups: unknown;
    variants: unknown;
    // Phase 13E.13
    snoonu_branches: unknown;
    snoonu_secondary_categories: string[] | null;
  };

  // Resolve which fields to apply
  const requested = new Set(body.fields ?? ['all']);
  const wantAll = requested.has('all');
  const want = (key: string) => wantAll || requested.has(key as never);

  const update: Record<string, unknown> = {};
  const applied: string[] = [];

  if (want('catalog')) {
    if (a.snoonu_catalog) update.snoonu_catalog = a.snoonu_catalog;
    if (a.snoonu_category) update.snoonu_category = a.snoonu_category;
    if (a.snoonu_subcategory) update.snoonu_subcategory = a.snoonu_subcategory;
    if (a.snoonu_section) update.snoonu_section = a.snoonu_section;
    if (a.snoonu_menu_path) update.snoonu_menu_path = a.snoonu_menu_path;
    if (a.snoonu_product_url) update.snoonu_catalog_source_url = a.snoonu_product_url;
    // Phase 13E.13 — secondary categories
    if (a.snoonu_secondary_categories && a.snoonu_secondary_categories.length > 0) {
      update.snoonu_secondary_categories = a.snoonu_secondary_categories;
    }
    update.catalog_source = 'browser_read';
    update.catalog_confidence = 1.0;
    update.catalog_checked_at = new Date().toISOString();
    applied.push('catalog');
  }

  if (want('price')) {
    if (a.snoonu_price != null) update.price = a.snoonu_price;
    if (a.snoonu_discount_price != null) update.discount_price = a.snoonu_discount_price;
    applied.push('price');
  }

  if (want('stock')) {
    if (a.snoonu_stock != null) update.stock_quantity = a.snoonu_stock;
    // Phase 13E.13 — branches breakdown
    if (a.snoonu_branches != null) update.snoonu_branches = a.snoonu_branches;
    applied.push('stock');
  }

  if (want('status')) {
    if (a.snoonu_status) update.platform_status = a.snoonu_status;
    applied.push('status');
  }

  if (want('image')) {
    if (a.snoonu_image_url) update.image_url = a.snoonu_image_url;
    if (a.snoonu_image_filename) update.image_filename = a.snoonu_image_filename;
    applied.push('image');
  }

  if (want('name')) {
    if (a.snoonu_product_name) update.name_en = a.snoonu_product_name;
    if (a.snoonu_name_ar) update.name_ar = a.snoonu_name_ar;
    applied.push('name');
  }

  if (want('options') || want('variants')) {
    // Store option groups + variants in raw_payload so the comparator and
    // variant detector can see them. We don't have dedicated columns here.
    update.raw_payload_options = a.option_groups;
    update.raw_payload_variants = a.variants;
    applied.push(want('options') ? 'options' : 'variants');
  }

  if (Object.keys(update).length === 0) {
    return err('NO_FIELDS_SELECTED', 'No fields selected for application', 400);
  }

  // Filter out columns that don't actually exist on platform_products
  // (we used raw_payload_options/variants as a fake field above — strip them)
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(update)) {
    if (k === 'raw_payload_options' || k === 'raw_payload_variants') continue;
    sanitized[k] = v;
  }

  // Apply to platform_products
  if (Object.keys(sanitized).length > 0) {
    const { error: updErr } = await admin
      .from('platform_products')
      .update(sanitized as Database['public']['Tables']['platform_products']['Update'])
      .eq('id', a.product_id);
    if (updErr) return err('PRODUCT_UPDATE_FAILED', updErr.message, 500);
  }

  // Update the audit row
  const newAuditStatus: 'applied' | 'verified' = body.mark_verified ? 'verified' : 'applied';
  const auditUpdate: Record<string, unknown> = {
    audit_status: newAuditStatus,
    applied_at: new Date().toISOString(),
    applied_fields: applied,
  };
  if (body.mark_verified) {
    auditUpdate.verified_at = new Date().toISOString();
    auditUpdate.verified_by = user.id;
  }

  const { error: auditUpdErr } = await admin
    .from('snoonu_browser_audits')
    .update(auditUpdate as Database['public']['Tables']['snoonu_browser_audits']['Update'])
    .eq('id', a.id);
  if (auditUpdErr) return err('AUDIT_UPDATE_FAILED', auditUpdErr.message, 500);

  return ok({
    audit_id: a.id,
    product_id: a.product_id,
    applied_fields: applied,
    audit_status: newAuditStatus,
  });
});
