/**
 * Shared Bulk-AI product creation.
 *
 * Extracted verbatim from /api/bulk-ai/process so the recovery flow
 * (/api/bulk-ai/recover) can create a real product from a saved ai_draft
 * using the SAME brand-resolution, FK-coercion, payload shape, defaults and
 * schema-cache-aware insert — WITHOUT calling Claude or any AI.
 *
 * `process/route.ts` delegates its FK-resolve + payload-build + insert step to
 * `createProductFromSuggestion`; its external behaviour (responses, safety-net,
 * usage logging) is unchanged. Callers map the discriminated result to their
 * own responses.
 */
import { z } from 'zod';
import type { Json } from '@malikas/db';
import type { createAdminSupabaseClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export const FALLBACK_CATEGORY_ID = 11; // "Trending Products"
export const FALLBACK_BRAND_NAME = 'Unknown';

// ─── Suggestion schema (the bilingual Malika block) ───────────────────────────
// Single source of truth for both process (Claude output) and recover
// (ai_drafts.suggestion). Kept structurally identical to the previous inline
// schema in process/route.ts.
export const Suggestion = z.object({
  product_name_en: z.string().nullable().optional(),
  product_name_ar: z.string().nullable().optional(),
  product_type: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  brand_hint: z.string().nullable().optional(),
  category_hint: z.string().nullable().optional(),
  subcategory_hint: z.string().nullable().optional(),
  description_en: z.string().nullable().optional(),
  description_ar: z.string().nullable().optional(),
  usage_en: z.string().nullable().optional(),
  usage_ar: z.string().nullable().optional(),
  keywords_en: z.array(z.string()).nullable().optional(),
  keywords_ar: z.array(z.string()).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
});
export type SuggestionT = z.infer<typeof Suggestion>;

// ─── Self-healing brand resolver ─────────────────────────────────────────────

/**
 * Look up a brand by name. If it doesn't exist, INSERT it.
 * Returns null only if we can't even INSERT (RLS / connection issue).
 */
export async function resolveOrCreateBrand(admin: Admin, rawName: string | null | undefined): Promise<number | null> {
  if (!rawName) return null;
  const name = rawName.trim();
  if (name.length === 0) return null;

  // 1. Try exact case-insensitive match
  const { data: existing } = await admin.from('brands').select('id').ilike('name', name).maybeSingle();
  if (existing) return existing.id;

  // 2. Auto-create the brand
  const code = generateBrandCode(name);
  const { data: created, error } = await admin
    .from('brands')
    .insert({ name, code, country_origin: 'Auto-detected', is_active: true })
    .select('id')
    .single();

  if (error || !created) {
    // Race: another request created it between our SELECT and INSERT
    if (error?.code === '23505') {
      const { data: retry } = await admin.from('brands').select('id').ilike('name', name).maybeSingle();
      if (retry) return retry.id;
    }
    return null;
  }
  return created.id;
}

/** Build a 3-letter brand code from a name. "Etude House" → ETH, "Anua" → ANU. */
export function generateBrandCode(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'XXX';
  if (words.length === 1) return words[0]!.slice(0, 3).padEnd(3, 'X');
  return words.map((w) => w[0]).join('').slice(0, 3).padEnd(3, 'X');
}

// ─── Insert helpers (moved verbatim from process) ─────────────────────────────

/** Detects the PostgREST "schema cache" error class so the caller can retry. */
export function isSchemaCacheError(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  const m = (error.message ?? '').toLowerCase();
  const c = (error.code ?? '').toUpperCase();
  return (
    c === 'PGRST204' || c === 'PGRST205' || c === 'PGRST202' ||
    m.includes('schema cache') || m.includes('could not find')
  );
}

/** Convert any incoming value to a positive integer or null. */
export function toIntOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  if (typeof v === 'bigint') return Number(v) > 0 ? Number(v) : null;
  return null;
}

/** Tries to pull a column name out of a Postgres / PostgREST error message. */
export function extractColumnFromMessage(msg: string): string | null {
  const patterns = [/column "([^"]+)"/i, /'([^']+)' column/i, /column ([a-z_]+) /i];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m) return m[1]!;
  }
  return null;
}

/** Trim long strings / arrays so logs & safety-net rows stay manageable. */
export function snapshotPayload<T extends Record<string, unknown>>(p: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && v.length > 400) out[k] = v.slice(0, 400) + `…(+${v.length - 400} chars)`;
    else if (Array.isArray(v)) out[k] = v.slice(0, 8);
    else out[k] = v;
  }
  return out;
}

// ─── Core: create a product from a suggestion (+ optional overrides) ──────────

export interface ProductOverrides {
  brandId?: number | null;
  brandName?: string | null;
  categoryId?: number | null;
  subcategoryId?: number | null;
}

export interface CreatedProduct {
  id: number;
  master_sku: string;
  ai_confidence: number | null;
  product_name_en: string;
  product_name_ar: string;
}

/**
 * The product columns the app controls. Deliberately EXCLUDES the DB-managed /
 * audit fields (id, master_sku, created_at, updated_at, created_by, updated_by):
 * master_sku is minted by the products BEFORE INSERT trigger, and the recovery
 * RPC forces created_by/updated_by to the actor inside SQL.
 */
export interface ProductPayload {
  product_name_en: string;
  product_name_ar: string;
  brand_id: number;
  category_id: number;
  subcategory_id: number | null;
  product_type: string | null;
  variant: string | null;
  color: string | null;
  size: string | null;
  price: number;
  stock_quantity: number;
  stock_status: 'out_of_stock';
  product_status: 'draft';
  description_en: string | null;
  description_ar: string | null;
  usage_en: string | null;
  usage_ar: string | null;
  keywords_en: string[] | null;
  keywords_ar: string[] | null;
  source_platform: 'manual';
  image_url: string;
  image_filename: string;
  ai_generated: true;
  ai_confidence: number;
  ai_meta: Json;
}

export interface PreparedProduct {
  payload: ProductPayload;
  resolved: { brand_id: number; category_id: number; subcategory_id: number | null };
}

export type PrepareProductResult =
  | { ok: true; prepared: PreparedProduct }
  | { ok: false; stage: 'brand' | 'coerce'; code: string; message: string; failing_column: string | null };

export interface PrepareProductArgs {
  admin: Admin;
  suggestion: SuggestionT;
  overrides?: ProductOverrides;
  confidence: number;
  aiMeta: Record<string, unknown>;
  imageUrl: string;
  originalFilename: string;
}

export type CreateProductResult =
  | { ok: true; product: CreatedProduct; resolved: { brand_id: number; category_id: number; subcategory_id: number | null } }
  | { ok: false; stage: 'brand' | 'coerce' | 'insert'; code: string; message: string; failing_column: string | null; payloadSnapshot: Record<string, unknown> | null; raw?: { code?: string; details?: string | null; hint?: string | null } };

export interface CreateProductArgs extends PrepareProductArgs {
  actorEmail: string;
  /** Optional hook so process can clear its per-process schema cache on a cache miss. */
  onSchemaReload?: () => void;
}

/**
 * Validate + resolve brand/category/subcategory + build the product insert
 * payload with the existing defaults. Does NOT insert — used by both the
 * legacy insert path (`createProductFromSuggestion`) and the transactional
 * recovery RPC (which performs the insert atomically inside PostgreSQL).
 *
 * When `overrides.brandId/categoryId/subcategoryId` are provided they are used
 * verbatim (the CALLER must have already validated they exist). Otherwise the
 * self-healing name-based resolution runs exactly as before. Never calls AI.
 */
export async function prepareProductFromSuggestion(args: PrepareProductArgs): Promise<PrepareProductResult> {
  const { admin, suggestion: s, overrides, confidence, aiMeta, imageUrl, originalFilename } = args;

  // 1. Brand — explicit override id wins, else name (override name → hint → Unknown fallback)
  let brand_id: number | null;
  if (overrides?.brandId != null) {
    brand_id = overrides.brandId;
  } else {
    brand_id = await resolveOrCreateBrand(admin, overrides?.brandName ?? s.brand_hint);
    if (brand_id == null) brand_id = await resolveOrCreateBrand(admin, FALLBACK_BRAND_NAME);
  }
  if (brand_id == null) {
    return {
      ok: false, stage: 'brand', code: 'BRAND_RESOLUTION_FAILED',
      message: 'Could not resolve or create any brand for this product. Check service-role permissions.',
      failing_column: null,
    };
  }

  // 2. Category — explicit override id wins, else hint lookup, else fallback
  let category_id: number = FALLBACK_CATEGORY_ID;
  if (overrides?.categoryId != null) {
    category_id = overrides.categoryId;
  } else if (s.category_hint) {
    const { data: cat } = await admin.from('categories').select('id').ilike('name', s.category_hint).maybeSingle();
    if (cat) category_id = cat.id;
  }

  // 3. Subcategory — explicit override id wins, else hint lookup within category
  let subcategory_id: number | null = null;
  if (overrides?.subcategoryId != null) {
    subcategory_id = overrides.subcategoryId;
  } else if (s.subcategory_hint && category_id) {
    const { data: sub } = await admin
      .from('subcategories').select('id').eq('category_id', category_id).ilike('name', s.subcategory_hint).maybeSingle();
    if (sub) subcategory_id = sub.id;
  }

  // 4. Coerce FK ids (PostgREST may serialize SERIAL ids as strings)
  const brand_id_num = toIntOrNull(brand_id);
  const category_id_num = toIntOrNull(category_id);
  const subcategory_id_num = toIntOrNull(subcategory_id);
  if (brand_id_num == null || category_id_num == null) {
    return {
      ok: false, stage: 'coerce', code: 'BAD_FK_TYPES',
      message: `Could not coerce FK ids to integers (brand_id=${brand_id}, category_id=${category_id}).`,
      failing_column: null,
    };
  }

  // 5. Build product payload — identical defaults to the original process route
  //    (created_by / updated_by / master_sku are NOT set here — see ProductPayload)
  const product_name_en = s.product_name_en?.trim() || `Untitled — ${originalFilename}`;
  const product_name_ar = s.product_name_ar?.trim() || product_name_en;

  const payload: ProductPayload = {
    product_name_en,
    product_name_ar,
    brand_id: brand_id_num,
    category_id: category_id_num,
    subcategory_id: subcategory_id_num,
    product_type: s.product_type ?? null,
    variant: s.variant ?? null,
    color: s.color ?? null,
    size: s.size ?? null,
    price: 0,
    stock_quantity: 0,
    stock_status: 'out_of_stock',
    product_status: 'draft',
    description_en: s.description_en ?? null,
    description_ar: s.description_ar ?? null,
    usage_en: s.usage_en ?? null,
    usage_ar: s.usage_ar ?? null,
    keywords_en: Array.isArray(s.keywords_en) ? s.keywords_en : null,
    keywords_ar: Array.isArray(s.keywords_ar) ? s.keywords_ar : null,
    source_platform: 'manual',
    image_url: imageUrl,
    image_filename: originalFilename,
    ai_generated: true,
    ai_confidence: Number(confidence),
    ai_meta: aiMeta as Json,
  };

  return { ok: true, prepared: { payload, resolved: { brand_id: brand_id_num, category_id: category_id_num, subcategory_id: subcategory_id_num } } };
}

/**
 * Resolve + build (via `prepareProductFromSuggestion`) then INSERT the product
 * with the schema-cache retry. Kept for `process/route.ts`, whose external
 * behaviour (payload, defaults, safety-net, responses) is unchanged. Never AI.
 */
export async function createProductFromSuggestion(args: CreateProductArgs): Promise<CreateProductResult> {
  const { admin, actorEmail, onSchemaReload } = args;

  const prep = await prepareProductFromSuggestion(args);
  if (!prep.ok) {
    return { ok: false, stage: prep.stage, code: prep.code, message: prep.message, failing_column: prep.failing_column, payloadSnapshot: null };
  }

  // Add the audit fields the legacy insert path has always written.
  const insertPayload = { ...prep.prepared.payload, created_by: actorEmail, updated_by: actorEmail };

  // INSERT with schema-cache retry
  const tryInsert = async () =>
    admin.from('products').insert(insertPayload)
      .select('id, master_sku, ai_confidence, product_name_en, product_name_ar').single();

  let { data: product, error: insertErr } = await tryInsert();

  if (insertErr && isSchemaCacheError(insertErr)) {
    onSchemaReload?.();
    try {
      await admin.rpc('pg_notify' as never, { channel: 'pgrst', payload: 'reload schema' } as never);
    } catch {
      // RPC may not exist — NOTIFY also fires from migration 0005
    }
    await new Promise((r) => setTimeout(r, 750));
    const retry = await tryInsert();
    product = retry.data;
    insertErr = retry.error;
  }

  if (insertErr || !product) {
    return {
      ok: false, stage: 'insert',
      code: (insertErr?.code ?? 'INSERT_FAILED').toUpperCase() || 'INSERT_FAILED',
      message: insertErr?.message ?? 'Unknown insert error',
      failing_column: extractColumnFromMessage(insertErr?.message ?? ''),
      payloadSnapshot: snapshotPayload(insertPayload),
      raw: { code: insertErr?.code, details: insertErr?.details ?? null, hint: insertErr?.hint ?? null },
    };
  }

  return { ok: true, product, resolved: prep.prepared.resolved };
}
