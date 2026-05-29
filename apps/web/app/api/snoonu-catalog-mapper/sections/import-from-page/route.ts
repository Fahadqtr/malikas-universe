/**
 * POST /api/snoonu-catalog-mapper/sections/import-from-page
 *
 * Read-only intake of Snoonu catalog overview page text. Parses section names
 * + product counts and upserts them into snoonu_catalog_sections.
 *
 * Body:
 *   {
 *     raw_page_text: string,         // text you pasted/scraped from Snoonu portal
 *     source_url?: string,           // the page URL (for audit)
 *     replace?: boolean              // if true, deletes prior sections from this URL first
 *   }
 *
 * Returns:
 *   { parsed: ParsedSection[], inserted: number, skipped: number, total_sections: number }
 *
 * Never writes anything to Snoonu.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import { parseSnoonuCatalogPage } from '@/lib/reconciliation/snoonu-section-matcher';

export const runtime = 'nodejs';
export const maxDuration = 60;

const Schema = z.object({
  raw_page_text: z.string().min(1).max(500_000),
  source_url: z.string().url().optional().nullable(),
  replace: z.boolean().optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Schema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();

  const parsed = parseSnoonuCatalogPage(body.raw_page_text);
  if (parsed.length === 0) {
    return err(
      'NO_SECTIONS_PARSED',
      'No catalog sections could be parsed from the pasted text. Make sure you pasted the catalog overview page (the page that lists sections like "Hair Care", "Face Care", etc).',
      400,
      { raw_text_preview: body.raw_page_text.slice(0, 200) },
    );
  }

  // Optional cleanup of prior rows from this URL
  if (body.replace && body.source_url) {
    await admin
      .from('snoonu_catalog_sections')
      .delete()
      .eq('source_url', body.source_url);
  }

  // Upsert each parsed section. UNIQUE INDEX is on (name, coalesce(url, ''))
  // so we manually dedupe by reading first.
  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const s of parsed) {
    const sourceUrl = body.source_url ?? null;
    // Check if it exists
    const { data: existing } = await admin
      .from('snoonu_catalog_sections')
      .select('id, product_count')
      .eq('catalog_name_en', s.name_en)
      .eq('source_url', sourceUrl ?? '')
      .maybeSingle();

    if (existing) {
      // Refresh count + scraped_at if the new data has a count we didn't have
      const ex = existing as { id: number; product_count: number | null };
      if (s.product_count !== null && (ex.product_count == null || ex.product_count !== s.product_count)) {
        await admin
          .from('snoonu_catalog_sections')
          .update({ product_count: s.product_count, scraped_at: now, raw_text: s.raw_line })
          .eq('id', ex.id);
      }
      skipped++;
    } else {
      await admin.from('snoonu_catalog_sections').insert({
        catalog_name_en: s.name_en,
        product_count: s.product_count,
        source_url: sourceUrl,
        raw_text: s.raw_line,
        scraped_at: now,
      });
      inserted++;
    }
  }

  // Return the full sections list so the UI can re-render
  const { data: allSections } = await admin
    .from('snoonu_catalog_sections')
    .select('id, catalog_name_en, catalog_name_ar, product_count, source_url, scraped_at')
    .order('catalog_name_en', { ascending: true });

  return ok({
    parsed,
    inserted,
    skipped,
    total_sections: allSections?.length ?? 0,
    sections: allSections ?? [],
  });
});
