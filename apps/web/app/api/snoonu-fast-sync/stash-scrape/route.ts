/**
 * POST /api/snoonu-fast-sync/stash-scrape
 *
 * Receives a scrape payload from the Snoonu portal tab and stores it for
 * later processing by the admin tab. Designed to work over no-cors mode
 * (Content-Type: text/plain) — the body is read as raw text and parsed.
 *
 * We park the data in a special row in `snoonu_section_scrapes` with
 * status='running' and raw_payload set. A follow-up call to
 * /api/snoonu-fast-sync/process-stashed-scrapes will actually apply it.
 *
 * READ-ONLY against Snoonu. Local-DB write only.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const text = await req.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    return err('PARSE_FAILED', `Body is not valid JSON: ${(e as Error).message}`, 400);
  }
  const obj = parsed as { sections?: Array<{ section_name: string; products: unknown[] }> };
  if (!obj?.sections || !Array.isArray(obj.sections)) {
    return err('BAD_BODY', 'Body must include sections[]', 400);
  }
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('snoonu_section_scrapes')
    .insert({
      section_name: '__stashed_batch__',
      source_url: obj.sections[0]?.products?.length ? 'https://snoonu-portal.snoonu.com/v2/dashboard/catalog' : '',
      pages_scanned: 1,
      products_found: obj.sections.reduce((a, s) => a + (s.products?.length ?? 0), 0),
      status: 'running',
      raw_payload: parsed,
    })
    .select('id')
    .single();
  if (error) return err('STASH_FAILED', error.message, 500);
  return new Response(JSON.stringify({ ok: true, data: { stash_id: data?.id, sections: obj.sections.length } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
});
