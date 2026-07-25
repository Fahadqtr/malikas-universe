/**
 * POST /api/snoonu-catalog-mapper/set
 *
 * Save catalog mapping for one or more platform_products rows.
 *
 * Body shapes (one of):
 *   { row_ids: number[],            mapping: CatalogMapping }   — bulk apply
 *   { row_id:  number,              mapping: CatalogMapping }   — single row
 *   { row_id:  number,              manual_paste: { input, source_url? } }
 *   { row_id:  number,              browser_blob: BrowserDomBlob }
 *
 * READ-ONLY guarantee: this only writes to platform_products in our own DB.
 * Nothing is ever pushed to Snoonu.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import {
  parseManualPaste,
  parseFromBrowserDom,
  type CatalogMapping,
} from '@/lib/reconciliation/snoonu-catalog';

export const runtime = 'nodejs';

const MappingSchema = z.object({
  snoonu_catalog: z.string().nullable().optional(),
  snoonu_category: z.string().nullable().optional(),
  snoonu_subcategory: z.string().nullable().optional(),
  snoonu_section: z.string().nullable().optional(),
  snoonu_collection: z.string().nullable().optional(),
  snoonu_menu_path: z.string().nullable().optional(),
  snoonu_catalog_source_url: z.string().nullable().optional(),
  catalog_source: z.enum(['export_column', 'manual_paste', 'browser_read', 'inferred']).nullable().optional(),
  catalog_confidence: z.number().min(0).max(1).nullable().optional(),
});

const Schema = z.union([
  z.object({
    row_ids: z.array(z.number().int()).min(1).max(2000),
    mapping: MappingSchema,
  }),
  z.object({
    row_id: z.number().int(),
    mapping: MappingSchema,
  }),
  z.object({
    row_id: z.number().int(),
    manual_paste: z.object({
      input: z.string().min(1),
      source_url: z.string().url().nullable().optional(),
    }),
  }),
  z.object({
    row_id: z.number().int(),
    browser_blob: z.object({
      breadcrumb: z.array(z.string()).optional(),
      menu_label: z.string().nullable().optional(),
      category_field_value: z.string().nullable().optional(),
      subcategory_field_value: z.string().nullable().optional(),
      section_label: z.string().nullable().optional(),
      collection_label: z.string().nullable().optional(),
      page_url: z.string().url().nullable().optional(),
    }),
  }),
]);

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();
  const now = new Date().toISOString();

  // Resolve which mapping to apply
  let mapping: CatalogMapping;
  if ('manual_paste' in body) {
    mapping = parseManualPaste(body.manual_paste.input, body.manual_paste.source_url ?? null);
  } else if ('browser_blob' in body) {
    mapping = parseFromBrowserDom(body.browser_blob);
  } else {
    // Direct mapping payload — fill defaults
    mapping = {
      snoonu_catalog: body.mapping.snoonu_catalog ?? null,
      snoonu_category: body.mapping.snoonu_category ?? null,
      snoonu_subcategory: body.mapping.snoonu_subcategory ?? null,
      snoonu_section: body.mapping.snoonu_section ?? null,
      snoonu_collection: body.mapping.snoonu_collection ?? null,
      snoonu_menu_path:
        body.mapping.snoonu_menu_path ??
        ([
          body.mapping.snoonu_catalog,
          body.mapping.snoonu_category,
          body.mapping.snoonu_subcategory,
          body.mapping.snoonu_section,
          body.mapping.snoonu_collection,
        ]
          .filter((v): v is string => !!v && v.trim().length > 0)
          .join(' > ') || null),
      snoonu_catalog_source_url: body.mapping.snoonu_catalog_source_url ?? null,
      catalog_source: body.mapping.catalog_source ?? 'manual_paste',
      catalog_confidence: body.mapping.catalog_confidence ?? null,
    };
  }

  const targetIds: number[] = 'row_ids' in body ? body.row_ids : [body.row_id];

  const { error: updErr, count } = await admin
    .from('platform_products')
    .update(
      {
        ...mapping,
        catalog_checked_at: now,
      },
      { count: 'exact' },
    )
    .in('id', targetIds)
    .eq('platform', 'snoonu');

  if (updErr) return err('UPDATE_FAILED', updErr.message, 500);

  return ok({
    updated: count ?? targetIds.length,
    applied: mapping,
  });
});
