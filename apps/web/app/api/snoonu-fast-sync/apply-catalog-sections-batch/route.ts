/**
 * POST /api/snoonu-fast-sync/apply-catalog-sections-batch
 *
 * Phase 13F.13. Apply MULTIPLE Snoonu catalog sections in one transactional
 * batch. Loads candidates once, then matches + writes each section's links
 * + updates primaries/secondaries in a single pass.
 *
 * Body:
 *   {
 *     sections: [
 *       { section_name, source_url, pages_scanned?, products: [{spi, name, price?, image_url?}] },
 *       ...
 *     ]
 *   }
 *
 * Returns:
 *   {
 *     total_sections, total_products_found, total_matched, total_unmatched,
 *     primaries_set, secondaries_added,
 *     per_section: [{ scrape_id, section_name, found, matched, unmatched, ... }]
 *   }
 *
 * READ-ONLY against Snoonu. Only writes to local DB.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import {
  buildCandidateIndexes,
  matchScrapedProduct,
  reconcileSections,
  type CandidateProduct,
} from '@/lib/reconciliation/snoonu-section-page-matcher';

export const runtime = 'nodejs';
export const maxDuration = 120;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

const Schema = z.object({
  sections: z.array(z.object({
    section_name: z.string().min(1).max(120),
    source_url: z.string().min(1),
    pages_scanned: z.number().int().min(1).default(1),
    products: z.array(z.object({
      spi: z.string().nullable().optional(),
      name: z.string().min(1),
      price: z.number().nullable().optional(),
      image_url: z.string().nullable().optional(),
    })).max(500),
  })).min(1).max(50),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());
  const admin = createAdminSupabaseClient();

  // ─── 1. Load candidates ONCE (only Fast-Sync rows with SPI) ─────────────
  const { data: candidates, error: candErr } = await admin
    .from('platform_products')
    .select(
      `id, snoonu_spi, source_product_id, normalized_name, name_en, price,
       snoonu_category, snoonu_secondary_categories`,
    )
    .eq('platform', 'snoonu')
    .not('snoonu_spi', 'is', null)
    .limit(5000);
  if (candErr) return err('LOAD_FAILED', candErr.message, 500);
  const candList = (candidates ?? []) as CandidateProduct[];
  const indexes = buildCandidateIndexes(candList);

  // ─── 2. Aggregate per-product section assignments ──────────────────────
  // For each platform_products.id, collect ALL the sections it was found in
  // this batch. Then decide primary/secondaries once.
  const observedBySectionPerProduct = new Map<number, string[]>(); // productId → [section names observed]
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
  const perSection: Array<{
    scrape_id: number;
    section_name: string;
    found: number;
    matched: number;
    unmatched: number;
    duplicates: number;
    sample_unmatched: Array<Record<string, unknown>>;
  }> = [];

  for (const sec of body.sections) {
    // Insert scrape run row (status: running)
    const { data: scrapeRow, error: scrapeErr } = await admin
      .from('snoonu_section_scrapes')
      .insert({
        section_name: sec.section_name,
        source_url: sec.source_url,
        pages_scanned: sec.pages_scanned,
        products_found: sec.products.length,
        status: 'running',
      })
      .select('id')
      .single();
    if (scrapeErr || !scrapeRow) {
      return err('SCRAPE_INSERT_FAILED', scrapeErr?.message ?? 'no row', 500);
    }
    const scrapeId = scrapeRow.id;

    let matched = 0;
    let unmatched = 0;
    let duplicates = 0;
    const sampleUnmatched: Array<Record<string, unknown>> = [];
    const seenInSection = new Set<string>();

    for (const p of sec.products) {
      const key = p.spi ?? p.name.toLowerCase().trim();
      if (seenInSection.has(key)) duplicates++;
      else seenInSection.add(key);

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
          section_name: sec.section_name,
          product_id: null,
          scraped_spi: p.spi ?? null,
          scraped_name: p.name,
          scraped_price: p.price ?? null,
          scraped_image_url: p.image_url ?? null,
          match_method: 'no_match',
          match_confidence: 0,
          is_primary_section: false,
        });
        if (sampleUnmatched.length < 10) sampleUnmatched.push({ spi: p.spi, name: p.name, price: p.price });
        continue;
      }
      matched++;
      linkInserts.push({
        scrape_id: scrapeId,
        section_name: sec.section_name,
        product_id: result.product_id,
        scraped_spi: p.spi ?? null,
        scraped_name: p.name,
        scraped_price: p.price ?? null,
        scraped_image_url: p.image_url ?? null,
        match_method: result.match_method as 'spi' | 'normalized_name' | 'fuzzy_name',
        match_confidence: result.match_confidence,
        is_primary_section: false, // resolved below after seeing all sections
      });

      const prev = observedBySectionPerProduct.get(result.product_id) ?? [];
      if (!prev.includes(sec.section_name)) prev.push(sec.section_name);
      observedBySectionPerProduct.set(result.product_id, prev);
    }

    perSection.push({
      scrape_id: scrapeId,
      section_name: sec.section_name,
      found: sec.products.length,
      matched,
      unmatched,
      duplicates,
      sample_unmatched: sampleUnmatched,
    });
  }

  // ─── 3. Reconcile primaries+secondaries per product ─────────────────────
  // Load current primaries for affected products to keep reconcileSections stable.
  const affectedIds = Array.from(observedBySectionPerProduct.keys());
  const existingMap = new Map<number, { primary: string | null; secondary: string[] }>();
  if (affectedIds.length > 0) {
    const { data: existing } = await admin
      .from('platform_products')
      .select('id, snoonu_category, snoonu_secondary_categories')
      .in('id', affectedIds);
    for (const r of (existing ?? []) as Array<{ id: number; snoonu_category: string | null; snoonu_secondary_categories: string[] | null }>) {
      existingMap.set(r.id, { primary: r.snoonu_category, secondary: r.snoonu_secondary_categories ?? [] });
    }
  }

  // Build updates
  const productUpdates: Array<{
    id: number;
    primary: string;
    secondary: string[];
    primarySection: string;
  }> = [];
  for (const [productId, observed] of observedBySectionPerProduct) {
    const existing = existingMap.get(productId) ?? { primary: null, secondary: [] };
    const reconciled = reconcileSections(existing.primary, observed);
    if (!reconciled.primary) continue;
    productUpdates.push({
      id: productId,
      primary: reconciled.primary,
      secondary: reconciled.secondary,
      primarySection: reconciled.primary,
    });
  }

  // Mark is_primary_section=true on the link rows whose section matches each product's resolved primary.
  for (const link of linkInserts) {
    if (link.product_id !== null) {
      const u = productUpdates.find((x) => x.id === link.product_id);
      if (u && u.primarySection === link.section_name) link.is_primary_section = true;
    }
  }

  // ─── 4. Insert all link rows ───────────────────────────────────────────
  if (linkInserts.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < linkInserts.length; i += CHUNK) {
      const { error: lErr } = await admin
        .from('snoonu_section_product_links')
        .insert(linkInserts.slice(i, i + CHUNK));
      if (lErr) return err('LINK_INSERT_FAILED', lErr.message, 500);
    }
  }

  // ─── 5. Apply product updates in parallel ──────────────────────────────
  let primariesSet = 0;
  let secondariesAdded = 0;
  const now = new Date().toISOString();
  const CHUNK = 50;
  for (let i = 0; i < productUpdates.length; i += CHUNK) {
    const chunk = productUpdates.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (u) => {
      const existing = existingMap.get(u.id) ?? { primary: null, secondary: [] };
      const mergedSecondary = Array.from(new Set([
        ...u.secondary,
        ...(existing.secondary ?? []).filter((s) => !u.secondary.includes(s) && s !== u.primary && !body.sections.some(sec => sec.section_name === s)),
      ]));
      await admin
        .from('platform_products')
        .update({
          snoonu_category: u.primary,
          snoonu_secondary_categories: mergedSecondary,
          snoonu_menu_path: mergedSecondary.length > 0 ? `${u.primary} | ${mergedSecondary.join(' | ')}` : u.primary,
          catalog_source: 'catalog_section_page',
          catalog_confidence: 1.0,
          catalog_checked_at: now,
          snoonu_catalog_source_url: body.sections[0].source_url,
        })
        .eq('id', u.id);
      if (existing.primary !== u.primary) primariesSet++;
      for (const s of mergedSecondary) {
        if (!(existing.secondary ?? []).includes(s)) secondariesAdded++;
      }
    }));
  }

  // ─── 6. Finalize all scrape rows ───────────────────────────────────────
  await Promise.all(perSection.map((ps) =>
    admin.from('snoonu_section_scrapes').update({
      products_matched: ps.matched,
      products_unmatched: ps.unmatched,
      duplicates_in_section: ps.duplicates,
      sample_unmatched: ps.sample_unmatched,
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', ps.scrape_id),
  ));

  return new Response(JSON.stringify({
    ok: true,
    data: {
      total_sections: body.sections.length,
      total_products_found: perSection.reduce((a, s) => a + s.found, 0),
      total_matched: perSection.reduce((a, s) => a + s.matched, 0),
      total_unmatched: perSection.reduce((a, s) => a + s.unmatched, 0),
      total_duplicates: perSection.reduce((a, s) => a + s.duplicates, 0),
      primaries_set: primariesSet,
      secondaries_added: secondariesAdded,
      per_section: perSection,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS } });
});
