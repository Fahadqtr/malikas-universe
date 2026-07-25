/**
 * POST /api/snoonu-fast-sync/quick-pass-fixes
 *
 * Phase 13F.20. Applies three rule overrides discovered during QA:
 *
 *   1. Brand priority — name has "Rhode"  → Rhode Products Section (always)
 *                       name has "Labubu" / "La Bobo" → Labubu Collection (always)
 *      catalog_source='rule_override_brand_priority', confidence=0.98
 *
 *   2. Hair override — name has hair/scalp/shampoo/conditioner/keratin/batana
 *                      + current category is Masks / Beauty Bundle / Beauty Accessories
 *      → Hair Care, catalog_source='rule_override_hair_specific', conf=0.92
 *
 *   3. Sun override — name has SPF/sun cream/sunscreen/sun stick/sun serum
 *                     + current category is Face Care / Beauty Bundle
 *      → Sun Protection, catalog_source='rule_override_sun_specific', conf=0.92
 *
 * Body: { dry_run?: boolean }
 *
 * Returns:
 *   { total_corrected, by_rule: {...}, samples: {...}, ambiguous_skipped: [...] }
 *
 * READ-ONLY against Snoonu. Local-DB write only.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

const Body = z.object({ dry_run: z.boolean().default(false) });

type Row = {
  id: number;
  name_en: string | null;
  snoonu_category: string | null;
  catalog_source: string | null;
  catalog_confidence: number | null;
};

const RE_RHODE = /\brhode\b/i;
const RE_LABUBU = /\blabubu\b|\bla\s*bobo\b/i;
const RE_HAIR = /\b(hair(?!\s*remover)|scalp|shampoo|conditioner|keratin|batana|hair\s*mask|hair\s*serum|hair\s*oil|hair\s*spray|hair\s*styling)\b/i;
const RE_SUN = /\b(spf\s*\d{2,3}\+?|spf|sun\s*cream|sunscreen|sun\s*stick|sun\s*serum|sun\s*protection|sun\s*block)\b/i;

const HAIR_RELOC_FROM: ReadonlyArray<string> = ['Masks', 'Beauty Bundle', 'Beauty Accessories'];
const SUN_RELOC_FROM: ReadonlyArray<string> = ['Face Care', 'Beauty Bundle'];

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body = Body.parse(await req.json().catch(() => ({})));
  const admin = createAdminSupabaseClient();

  // ─── 1. Load all categorized Snoonu products (paginated) ───────────────
  const rows: Row[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await admin
      .from('platform_products')
      .select('id, name_en, snoonu_category, catalog_source, catalog_confidence')
      .eq('platform', 'snoonu')
      .not('snoonu_category', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + 999);
    if (error) return err('LOAD_FAILED', error.message, 500);
    const chunk = (data ?? []) as Row[];
    if (chunk.length === 0) break;
    rows.push(...chunk);
    if (chunk.length < 1000) break;
  }

  // ─── 2. Categorize each row by which override should fire ──────────────
  type Action = { id: number; oldSection: string; newSection: string; rule: string; conf: number; name_en: string | null };
  const actions: Action[] = [];
  const ambiguous: Array<{ id: number; name_en: string | null; reason: string; current: string | null }> = [];

  for (const r of rows) {
    const name = r.name_en ?? '';
    if (!name) continue;

    // 1. Brand priority (highest — always wins)
    if (RE_RHODE.test(name) && r.snoonu_category !== 'Rhode Products Section') {
      actions.push({ id: r.id, oldSection: r.snoonu_category!, newSection: 'Rhode Products Section', rule: 'brand_priority', conf: 0.98, name_en: r.name_en });
      continue;
    }
    if (RE_LABUBU.test(name) && r.snoonu_category !== 'Labubu Collection') {
      actions.push({ id: r.id, oldSection: r.snoonu_category!, newSection: 'Labubu Collection', rule: 'brand_priority', conf: 0.98, name_en: r.name_en });
      continue;
    }

    // 2. Hair override (only if currently in Masks/Bundle/Accessories)
    if (RE_HAIR.test(name) && HAIR_RELOC_FROM.includes(r.snoonu_category!)) {
      // Ambiguity guard — if name ALSO suggests face/sun/eye, log + skip
      if (/\b(face|facial|eye|lip|sun|spf)\b/i.test(name)) {
        ambiguous.push({ id: r.id, name_en: r.name_en, reason: 'hair-rule matched but name also has face/eye/sun keyword', current: r.snoonu_category });
        continue;
      }
      actions.push({ id: r.id, oldSection: r.snoonu_category!, newSection: 'Hair Care', rule: 'hair_specific', conf: 0.92, name_en: r.name_en });
      continue;
    }

    // 3. Sun override (only if currently in Face Care/Bundle)
    if (RE_SUN.test(name) && SUN_RELOC_FROM.includes(r.snoonu_category!)) {
      // Ambiguity guard — exclude "sun" appearing as a brand word ("Beauty of Joseon Sun ..." is fine, but "Sunday" should be skipped)
      if (/\bsunday\b/i.test(name) && !/spf|sunscreen|sun\s+cream|sun\s+stick/i.test(name)) {
        ambiguous.push({ id: r.id, name_en: r.name_en, reason: 'sun-rule fired on "Sunday" — likely brand not SPF', current: r.snoonu_category });
        continue;
      }
      actions.push({ id: r.id, oldSection: r.snoonu_category!, newSection: 'Sun Protection', rule: 'sun_specific', conf: 0.92, name_en: r.name_en });
      continue;
    }
  }

  // ─── 3. Apply (unless dry_run) ─────────────────────────────────────────
  // FIXME: ideal catalog_source values are rule_override_brand_priority etc.
  // but that requires migration 0024 to be applied. Until then we fall back
  // to 'inferred' (already in the CHECK) and encode the rule via confidence:
  //   brand_priority → 0.98 (unique — no other rule uses this)
  //   hair_specific  → 0.92
  //   sun_specific   → 0.92
  // The Phase 13F.20 migration adds the proper values when applied.
  const ruleToSource: Record<string, string> = {
    brand_priority: 'inferred',
    hair_specific: 'inferred',
    sun_specific: 'inferred',
  };

  let writes = 0;
  const writeErrors: string[] = [];
  if (!body.dry_run && actions.length > 0) {
    const now = new Date().toISOString();
    // Group by (newSection, rule) so we can batch
    const groups = new Map<string, Action[]>();
    for (const a of actions) {
      const k = `${a.newSection}|${a.rule}|${a.conf}`;
      const arr = groups.get(k) ?? [];
      arr.push(a);
      groups.set(k, arr);
    }
    for (const [k, list] of groups) {
      const [section, rule, confStr] = k.split('|') as [string, string, string];
      const source = ruleToSource[rule];
      const conf = Number(confStr);
      const CHUNK = 200;
      for (let i = 0; i < list.length; i += CHUNK) {
        const slice = list.slice(i, i + CHUNK);
        const { error } = await admin
          .from('platform_products')
          .update({
            snoonu_category: section,
            snoonu_menu_path: section,
            catalog_source: source,
            catalog_confidence: conf,
            catalog_checked_at: now,
          })
          .in('id', slice.map((x) => x.id));
        if (error) writeErrors.push(error.message.slice(0, 120));
        else writes += slice.length;
      }
    }
  }

  // ─── 4. Reporting ──────────────────────────────────────────────────────
  const byRule: Record<string, { count: number; samples: Array<{ name: string | null; from: string; to: string }> }> = {
    brand_priority: { count: 0, samples: [] },
    hair_specific: { count: 0, samples: [] },
    sun_specific: { count: 0, samples: [] },
  };
  for (const a of actions) {
    const entry = byRule[a.rule];
    if (entry) {
      entry.count++;
      if (entry.samples.length < 8) {
        entry.samples.push({
          name: a.name_en?.slice(0, 70) ?? null,
          from: a.oldSection,
          to: a.newSection,
        });
      }
    }
  }

  return ok({
    dry_run: body.dry_run,
    total_categorized_rows_scanned: rows.length,
    total_corrected: actions.length,
    writes,
    write_errors: writeErrors,
    by_rule: byRule,
    ambiguous_skipped: ambiguous.slice(0, 15),
    ambiguous_count: ambiguous.length,
  });
});
