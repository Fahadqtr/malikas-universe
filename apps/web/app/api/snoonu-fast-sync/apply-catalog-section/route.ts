/**
 * POST /api/snoonu-fast-sync/apply-catalog-section
 *
 * Phase 13F.5/13F.6. Receives the scraped product list for ONE Snoonu
 * catalog section page and applies the mapping to platform_products.
 *
 * Body:
 *   {
 *     section_name:  string,                    // e.g. "Hair Care"
 *     source_url:    string,                    // section page URL
 *     pages_scanned: number,                    // how many paginated pages we read
 *     products: Array<{
 *       spi?:        string | null,             // 24-hex if visible
 *       name:        string,                    // visible product name
 *       price?:      number | null,
 *       image_url?:  string | null,
 *     }>
 *   }
 *
 * Strategy per scraped product:
 *   1. Match to platform_products via SPI / normalized_name / fuzzy
 *      (see snoonu-section-page-matcher.ts)
 *   2. If matched:
 *        - section becomes primary if current primary is null OR matches
 *        - otherwise section becomes a secondary
 *        - set catalog_source='catalog_section_page', catalog_confidence,
 *          catalog_checked_at, snoonu_catalog_source_url
 *   3. Always insert a row in snoonu_section_product_links (audit trail).
 *
 * READ-ONLY against Snoonu Portal. Only writes to our local DB.
 *
 * Returns:
 *   {
 *     scrape_id, section_name,
 *     products_found, products_matched, products_unmatched,
 *     duplicates_in_section,
 *     primaries_set, secondaries_set,
 *     sample_unmatched, sample_matches
 *   }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { Json } from '@malikas/db';
import {
  buildCandidateIndexes,
  matchScrapedProduct,
  reconcileSections,
  type CandidateProduct,
} from '@/lib/reconciliation/snoonu-section-page-matcher';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Allow same-machine cross-tab POSTs from the Snoonu portal helper script so
// the Cowork assistant can drive scrape → apply in a single JS turn.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const Schema = z.object({
  section_name: z.string().min(1).max(120),
  source_url: z.string().min(1),
  pages_scanned: z.number().int().min(1).default(1),
  products: z
    .array(
      z.object({
        spi: z.string().nullable().optional(),
        name: z.string().min(1),
        price: z.number().nullable().optional(),
        image_url: z.string().nullable().optional(),
      }),
    )
    .max(1000),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  // Owner-only gate FIRST — before body parse, admin client, or any DB work.
  await requireActor(ROLE_SETS.ownerOnly);

  const body = Schema.parse(await req.json());
  const admin = createAdminSupabaseClient();

  // ─── 1. Insert scrape-run row ──────────────────────────────────────────
  const { data: scrapeRow, error: scrapeErr } = await admin
    .from('snoonu_section_scrapes')
    .insert({
      section_name: body.section_name,
      source_url: body.source_url,
      pages_scanned: body.pages_scanned,
      products_found: body.products.length,
      status: 'running',
      raw_payload: { products: body.products.slice(0, 200) },
    })
    .select('id')
    .single();
  if (scrapeErr || !scrapeRow) {
    console.error(`[apply-catalog-section] scrape insert failed (section=${body.section_name})`, scrapeErr);
    return err('SCRAPE_INSERT_FAILED', 'Internal server error', 500);
  }
  const scrapeId = scrapeRow.id;

  // ─── 2. Detect duplicates within this scrape (same name appearing twice) ─
  const seenNames = new Set<string>();
  let duplicates_in_section = 0;
  for (const p of body.products) {
    const key = (p.spi ?? p.name.toLowerCase().trim());
    if (seenNames.has(key)) duplicates_in_section++;
    else seenNames.add(key);
  }

  // ─── 3. Load candidate platform_products rows ──────────────────────────
  // Supabase capps a single select at 1000 rows; we have ~5700 Snoonu rows
  // (Fast Sync inserted 1144 fresh + legacy from earlier imports). Page the
  // results so the indexes are complete.
  async function loadAllSnoonuCandidates(): Promise<CandidateProduct[]> {
    // Only rows from the latest Fast Sync (snoonu_spi populated) — that's
    // the authoritative current dataset. Legacy rows (no SPI) are stale.
    // This drops candidates from ~5700 to ~1144 and turns a 7s call into <1s.
    const { data, error } = await admin
      .from('platform_products')
      .select(
        `id, snoonu_spi, source_product_id, normalized_name, name_en, price,
         snoonu_category, snoonu_secondary_categories`,
      )
      .eq('platform', 'snoonu')
      .not('snoonu_spi', 'is', null)
      .order('id', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return (data ?? []) as CandidateProduct[];
  }
  let candList: CandidateProduct[];
  try {
    candList = await loadAllSnoonuCandidates();
  } catch (e) {
    console.error(`[apply-catalog-section] load candidates failed (section=${body.section_name})`, e);
    return err('LOAD_CANDIDATES_FAILED', 'Internal server error', 500);
  }
  const indexes = buildCandidateIndexes(candList);

  // ─── 4. Match every scraped product ────────────────────────────────────
  type ProductUpdate = {
    id: number;
    new_primary: string;
    new_secondary: string[];
    confidence: number;
    method: string;
  };
  const updatesByProductId = new Map<number, ProductUpdate>();
  const linkInserts: Array<{
    scrape_id: number;
    section_name: string;
    product_id: number | null;
    scraped_spi: string | null;
    scraped_name: string;
    scraped_price: number | null;
    scraped_image_url: string | null;
    match_method: 'spi' | 'normalized_name' | 'fuzzy_name' | 'no_match';
    match_confidence: number;
    is_primary_section: boolean;
  }> = [];

  let matched = 0;
  let unmatched = 0;
  const sampleUnmatched: Array<Record<string, unknown>> = [];
  const sampleMatches: Array<Record<string, unknown>> = [];

  for (const p of body.products) {
    const result = matchScrapedProduct(
      {
        spi: p.spi ?? null,
        name: p.name,
        price: p.price ?? null,
        image_url: p.image_url ?? null,
      },
      candList,
      indexes,
    );

    if (result.product_id === null) {
      unmatched++;
      linkInserts.push({
        scrape_id: scrapeId,
        section_name: body.section_name,
        product_id: null,
        scraped_spi: p.spi ?? null,
        scraped_name: p.name,
        scraped_price: p.price ?? null,
        scraped_image_url: p.image_url ?? null,
        match_method: 'no_match',
        match_confidence: 0,
        is_primary_section: false,
      });
      if (sampleUnmatched.length < 20) {
        sampleUnmatched.push({ spi: p.spi, name: p.name, price: p.price });
      }
      continue;
    }

    matched++;

    // Pull the existing primary so reconcileSections can be stable per row
    const existing = result.candidate!;
    const observedThisRun = [...(updatesByProductId.get(existing.id)?.new_secondary ?? []), body.section_name];
    // Build merge: existing primary + observed thus-far + this section
    const current_primary = updatesByProductId.get(existing.id)?.new_primary ?? existing.snoonu_category ?? null;
    const reconciled = reconcileSections(current_primary, observedThisRun);

    updatesByProductId.set(existing.id, {
      id: existing.id,
      new_primary: reconciled.primary ?? body.section_name,
      new_secondary: reconciled.secondary,
      confidence: Math.max(
        updatesByProductId.get(existing.id)?.confidence ?? 0,
        result.match_confidence,
      ),
      method: result.match_method,
    });

    linkInserts.push({
      scrape_id: scrapeId,
      section_name: body.section_name,
      product_id: existing.id,
      scraped_spi: p.spi ?? null,
      scraped_name: p.name,
      scraped_price: p.price ?? null,
      scraped_image_url: p.image_url ?? null,
      match_method: result.match_method as 'spi' | 'normalized_name' | 'fuzzy_name',
      match_confidence: result.match_confidence,
      is_primary_section: reconciled.primary === body.section_name,
    });

    if (sampleMatches.length < 10) {
      sampleMatches.push({
        scraped_name: p.name,
        matched_id: existing.id,
        matched_name: existing.name_en,
        method: result.match_method,
        confidence: result.match_confidence,
      });
    }
  }

  // ─── 5. Insert all section-product links ───────────────────────────────
  if (linkInserts.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < linkInserts.length; i += CHUNK) {
      const { error: linkErr } = await admin
        .from('snoonu_section_product_links')
        .insert(linkInserts.slice(i, i + CHUNK));
      if (linkErr) {
        console.error(`[apply-catalog-section] link insert failed (scrape_id=${scrapeId})`, linkErr);
        await admin
          .from('snoonu_section_scrapes')
          .update({ status: 'error', error_message: 'Catalog section apply failed', completed_at: new Date().toISOString() })
          .eq('id', scrapeId);
        return err('LINK_INSERT_FAILED', 'Internal server error', 500);
      }
    }
  }

  // ─── 6. Update platform_products for every matched product ─────────────
  // For each affected product, also UNION with existing secondaries that
  // belong to OTHER sections (so re-scraping Hair Care doesn't wipe out
  // Face Care from secondary[]).
  let primariesSet = 0;
  let secondariesAdded = 0;
  const now = new Date().toISOString();

  // Fetch the current secondaries fresh so we don't trample on other sections.
  const affectedIds = Array.from(updatesByProductId.keys());
  if (affectedIds.length > 0) {
    const { data: existingRows } = await admin
      .from('platform_products')
      .select('id, snoonu_category, snoonu_secondary_categories')
      .in('id', affectedIds);

    const existingMap = new Map<number, { primary: string | null; secondary: string[] }>();
    for (const r of (existingRows ?? []) as Array<{
      id: number;
      snoonu_category: string | null;
      snoonu_secondary_categories: string[] | null;
    }>) {
      existingMap.set(r.id, {
        primary: r.snoonu_category,
        secondary: r.snoonu_secondary_categories ?? [],
      });
    }

    const CHUNK = 50;
    const ids = Array.from(updatesByProductId.values());
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map(async (u) => {
          const existing = existingMap.get(u.id) ?? { primary: null, secondary: [] };

          // Merge: keep existing secondaries that came from OTHER sections,
          // and ensure this scrape's section ends up in either primary or
          // secondary (never both, never duplicated).
          const fromOtherSections = (existing.secondary ?? []).filter(
            (s) => s !== body.section_name && s !== u.new_primary,
          );
          const mergedSecondary = Array.from(
            new Set([...u.new_secondary, ...fromOtherSections].filter((s) => s !== u.new_primary)),
          );

          await admin
            .from('platform_products')
            .update({
              snoonu_category: u.new_primary,
              snoonu_secondary_categories: mergedSecondary,
              snoonu_menu_path:
                mergedSecondary.length > 0
                  ? `${u.new_primary} | ${mergedSecondary.join(' | ')}`
                  : u.new_primary,
              catalog_source: 'catalog_section_page',
              catalog_confidence: Math.min(1, Math.max(0, u.confidence)),
              catalog_checked_at: now,
              snoonu_catalog_source_url: body.source_url,
            })
            .eq('id', u.id);

          if (existing.primary !== u.new_primary) primariesSet++;
          for (const s of mergedSecondary) {
            if (!(existing.secondary ?? []).includes(s)) secondariesAdded++;
          }
        }),
      );
    }
  }

  // ─── 7. Finalize scrape run ────────────────────────────────────────────
  await admin
    .from('snoonu_section_scrapes')
    .update({
      products_matched: matched,
      products_unmatched: unmatched,
      duplicates_in_section,
      sample_unmatched: sampleUnmatched as Json,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', scrapeId);

  return ok({
    scrape_id: scrapeId,
    section_name: body.section_name,
    products_found: body.products.length,
    products_matched: matched,
    products_unmatched: unmatched,
    duplicates_in_section,
    primaries_set: primariesSet,
    secondaries_added: secondariesAdded,
    sample_unmatched: sampleUnmatched,
    sample_matches: sampleMatches,
  });
});
