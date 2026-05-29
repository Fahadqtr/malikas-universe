/**
 * POST /api/snoonu-catalog-mapper/auto-fill-from-sections
 *
 * Match every Snoonu product in an import to the closest catalog section
 * from snoonu_catalog_sections, then write that mapping to platform_products.
 *
 * Body:
 *   {
 *     import_id: number,
 *     only_missing?: boolean,     // default true — skip rows that already have snoonu_category
 *     min_confidence?: number,    // skip writes below this threshold (default 0.6)
 *   }
 *
 * Output:
 *   {
 *     scanned, matched, low_confidence, no_match,
 *     by_section: { "Hair Care": 45, "Face Care": 89, … }
 *   }
 *
 * Read-only with respect to Snoonu — only writes to platform_products.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import { matchProductToSection, type AvailableSection } from '@/lib/reconciliation/snoonu-section-matcher';

export const runtime = 'nodejs';
export const maxDuration = 180;

const Schema = z.object({
  import_id: z.number().int(),
  only_missing: z.boolean().optional(),
  min_confidence: z.number().min(0).max(1).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());
  const onlyMissing = body.only_missing ?? true;
  const minConfidence = body.min_confidence ?? 0.6;

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  // 1. Load the available sections (most recent scrape wins)
  const { data: sectionsRaw } = await admin
    .from('snoonu_catalog_sections')
    .select('catalog_name_en')
    .order('catalog_name_en', { ascending: true });

  const sections: AvailableSection[] = (sectionsRaw ?? []) as AvailableSection[];
  if (sections.length === 0) {
    return err(
      'NO_SECTIONS_LOADED',
      'No Snoonu catalog sections have been imported yet. Use the "Import catalog sections from current Snoonu page" button first.',
      400,
    );
  }

  // 2. Load the products to match
  let q = admin
    .from('platform_products')
    .select(
      `id, source_sku, name_en, name_ar, brand, normalized_name, product_type,
       category_name, snoonu_category`,
    )
    .eq('platform', 'snoonu')
    .eq('import_id', body.import_id);
  if (onlyMissing) q = q.is('snoonu_category', null);

  const { data: products, error: selErr } = await q;
  if (selErr) return err('SELECT_FAILED', selErr.message, 500);
  if (!products || products.length === 0) {
    return ok({
      scanned: 0,
      matched: 0,
      low_confidence: 0,
      no_match: 0,
      by_section: {},
    });
  }

  // 3. Run matcher + persist
  let matched = 0;
  let lowConf = 0;
  let noMatch = 0;
  const bySection: Record<string, number> = {};
  const now = new Date().toISOString();

  const BATCH = 50;
  for (let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH);
    await Promise.all(
      chunk.map(async (r) => {
        const row = r as {
          id: number;
          source_sku: string | null;
          name_en: string | null;
          name_ar: string | null;
          brand: string | null;
          normalized_name: string | null;
          product_type: string | null;
          category_name: string | null;
        };

        const result = matchProductToSection(
          {
            category_name: row.category_name,
            brand: row.brand,
            name_en: row.name_en ?? row.normalized_name,
            name_ar: row.name_ar,
            product_type: row.product_type,
          },
          sections,
        );

        if (!result) {
          noMatch++;
          return;
        }

        if (result.confidence < minConfidence) {
          lowConf++;
          return;
        }

        // Build the catalog path. The section IS the catalog name for now —
        // we don't know subcategory at this layer. Snoonu's catalog page is
        // flat (one level), so menu_path equals the section name.
        const sectionName = result.section_name;
        await admin
          .from('platform_products')
          .update({
            snoonu_catalog: sectionName,
            snoonu_category: sectionName,
            snoonu_subcategory: null,
            snoonu_section: sectionName,
            snoonu_collection: null,
            snoonu_menu_path: sectionName,
            snoonu_catalog_source_url: null,
            catalog_source: 'catalog_section_match',
            catalog_confidence: result.confidence,
            catalog_checked_at: now,
          })
          .eq('id', row.id);

        matched++;
        bySection[sectionName] = (bySection[sectionName] ?? 0) + 1;
      }),
    );
  }

  return ok({
    scanned: products.length,
    matched,
    low_confidence: lowConf,
    no_match: noMatch,
    by_section: bySection,
    min_confidence: minConfidence,
    available_sections: sections.map((s) => s.catalog_name_en),
  });
});
