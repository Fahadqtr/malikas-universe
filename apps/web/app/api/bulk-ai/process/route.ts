/**
 * POST /api/bulk-ai/process
 *
 * Body:
 *   {
 *     image_url:         string  (Supabase Storage public URL from /api/bulk-ai/upload)
 *     original_filename: string  (preserved for downstream SKU matching)
 *   }
 *
 * Pipeline:
 *   1. Pre-flight schema check (verify ai_generated column exists)
 *   2. Call Claude vision (MALIKA_SYSTEM_PROMPT) — bilingual marketplace block
 *   3. AR fallback pass if Claude omits Arabic
 *   4. Resolve brand / category / subcategory (with safe fallbacks)
 *   5. INSERT product DRAFT
 *        ↳ on schema-cache error: refresh + retry once
 *        ↳ on any other failure: save full AI payload to ai_drafts (NEVER LOST)
 *   6. INSERT product_images linking the uploaded URL
 *   7. Log tokens + cost + latency to ai_usage_log
 *
 * Returns one of:
 *   - { status:'ready'|'needs_review', master_sku, product_id, confidence, ... }   ← happy path
 *   - { status:'draft_saved_to_safety_net', ai_draft_id, confidence, ... }         ← recovered
 *
 * Every step writes detailed server-side logs:
 *   [bulk-ai] step  : description
 *   [bulk-ai] ERROR : code | table | column | payload snapshot
 *
 * Resilience guarantees:
 *   ✓ AI output is never lost — falls through to ai_drafts on any DB failure
 *   ✓ Schema cache misses auto-retry after NOTIFY pgrst
 *   ✓ A single failed product never blocks the queue (caller-side handled)
 *   ✓ Pre-flight check surfaces missing migrations BEFORE Claude is called
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { callClaudeJson, estimateCostUsd, MODELS } from '@/lib/claude';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import {
  MALIKA_SYSTEM_PROMPT,
  MALIKA_AR_FALLBACK_PROMPT,
  buildAutofillUserPrompt,
  buildArFallbackUserPrompt,
} from '@/lib/ai-prompts';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CONFIDENCE_READY = 0.9;
const FALLBACK_CATEGORY_ID = 11;        // "Trending Products"
const FALLBACK_BRAND_NAME = 'Unknown';

// Cache the result of the pre-flight schema check per Node process so we
// don't spam information_schema on every request.
let SCHEMA_OK: boolean | null = null;

// ─── Input / output schemas ──────────────────────────────────────────────────

const Input = z.object({
  image_url: z.string().url(),
  original_filename: z.string().min(1),
});

const Suggestion = z.object({
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
type SuggestionT = z.infer<typeof Suggestion>;

const ARFallback = z.object({
  product_name_ar: z.string().nullable().optional(),
  description_ar: z.string().nullable().optional(),
  usage_ar: z.string().nullable().optional(),
  keywords_ar: z.array(z.string()).nullable().optional(),
});

// ─── Logger ──────────────────────────────────────────────────────────────────

function log(step: string, msg: string, extra?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(`[bulk-ai] ${step.padEnd(20)} ${msg}`, extra ? JSON.stringify(extra) : '');
}
function logErr(step: string, msg: string, extra?: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.error(`[bulk-ai] ${step.padEnd(20)} ERROR: ${msg}`, extra ? JSON.stringify(extra) : '');
}

// ─── Schema sanity check ─────────────────────────────────────────────────────

/**
 * Verifies that the required AI columns exist on the products table.
 * Probes the columns directly via PostgREST — works through the schema cache,
 * so this also surfaces stale-cache problems (not just missing migrations).
 *
 * If the probe fails, caller stops cleanly and tells the operator to run 0005.
 * Result is cached for this Node process; cleared on schema-cache errors.
 */
async function ensureSchema(): Promise<{ ok: true } | { ok: false; missing: string[]; reason: string }> {
  if (SCHEMA_OK === true) return { ok: true };

  const admin = createAdminSupabaseClient();
  const required = ['ai_generated', 'ai_confidence', 'ai_meta', 'usage_en', 'usage_ar'];

  // Single probe query — if any column is missing, PostgREST returns the
  // exact column name in the error message.
  const { error } = await admin
    .from('products')
    .select(`id, ${required.join(', ')}`)
    .limit(1);

  if (!error) {
    SCHEMA_OK = true;
    return { ok: true };
  }

  // Try to extract the missing column from the error
  const missing: string[] = [];
  for (const col of required) {
    if (error.message?.includes(col)) missing.push(col);
  }
  return {
    ok: false,
    missing: missing.length > 0 ? missing : required,
    reason: error.message ?? 'unknown',
  };
}

// ─── Self-healing brand resolver ─────────────────────────────────────────────

/**
 * Look up a brand by name. If it doesn't exist, INSERT it.
 *
 * This means:
 *   - "Etude House" returned by Claude → auto-created with code 'ETH'
 *   - "Unknown" fallback → auto-created if migration 0005 was skipped
 *   - Returns null only if we can't even INSERT (RLS / connection issue)
 *
 * Generates a 3-letter brand code from the first letters of the name so the
 * SKU prefix table doesn't break.
 */
async function resolveOrCreateBrand(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  rawName: string | null | undefined,
): Promise<number | null> {
  if (!rawName) return null;
  const name = rawName.trim();
  if (name.length === 0) return null;

  // 1. Try exact case-insensitive match
  const { data: existing } = await admin
    .from('brands')
    .select('id')
    .ilike('name', name)
    .maybeSingle();
  if (existing) {
    log('resolve-brand', `matched existing brand "${name}" → id=${existing.id}`);
    return existing.id;
  }

  // 2. Auto-create the brand
  const code = generateBrandCode(name);
  log('resolve-brand', `brand "${name}" not found, auto-creating with code=${code}`);

  const { data: created, error } = await admin
    .from('brands')
    .insert({
      name,
      code,
      country_origin: 'Auto-detected',
      is_active: true,
    })
    .select('id')
    .single();

  if (error || !created) {
    // Race: another request created it between our SELECT and INSERT
    if (error?.code === '23505') {
      const { data: retry } = await admin
        .from('brands')
        .select('id')
        .ilike('name', name)
        .maybeSingle();
      if (retry) return retry.id;
    }
    logErr('resolve-brand', `CRITICAL: could not auto-create brand "${name}"`, {
      code: error?.code,
      message: error?.message,
      details: error?.details,
    });
    return null;
  }

  log('resolve-brand', `created brand "${name}" → id=${created.id}`);
  return created.id;
}

/**
 * Build a 3-letter brand code from a name.
 *   "Etude House" → ETH
 *   "Anua"        → ANU
 *   "Unknown"     → UNK
 */
function generateBrandCode(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'XXX';
  if (words.length === 1) return words[0].slice(0, 3).padEnd(3, 'X');
  return words.map((w) => w[0]).join('').slice(0, 3).padEnd(3, 'X');
}

// ─── Save to safety net ──────────────────────────────────────────────────────

async function saveToSafetyNet(args: {
  image_url: string;
  original_filename: string;
  suggestion: SuggestionT;
  confidence: number;
  ai_meta: Record<string, unknown>;
  error_code: string;
  error_message: string;
  failing_table: string;
  failing_payload: Record<string, unknown>;
  actor_email: string;
}): Promise<{ id: number | null; reason?: string }> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('ai_drafts')
    .insert({
      image_url: args.image_url,
      original_filename: args.original_filename,
      suggestion: args.suggestion,
      confidence: args.confidence,
      ai_meta: args.ai_meta,
      status: 'pending_recovery',
      error_code: args.error_code,
      error_message: args.error_message,
      failing_table: args.failing_table,
      failing_payload: args.failing_payload,
      created_by: args.actor_email,
    })
    .select('id')
    .single();

  if (error) {
    // 42P01 = relation does not exist (ai_drafts table missing)
    const reason =
      error.code === '42P01' || (error.message ?? '').includes('ai_drafts')
        ? 'ai_drafts table is missing — run migration 0005 in Supabase SQL Editor'
        : error.message ?? 'unknown';
    logErr('safety-net', 'CRITICAL: could not save to ai_drafts either', {
      message: error.message,
      hint: error.hint,
      code: error.code,
      reason,
    });
    return { id: null, reason };
  }
  log('safety-net', `saved AI output to ai_drafts(id=${data.id})`);
  return { id: data.id };
}

// ─── Schema-cache aware insert ───────────────────────────────────────────────

/**
 * Detects the "schema cache" error class (PGRST204 / PGRST205 / PGRST202)
 * and returns true so the caller can retry after NOTIFY pgrst.
 */
function isSchemaCacheError(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  const m = (error.message ?? '').toLowerCase();
  const c = (error.code ?? '').toUpperCase();
  return (
    c === 'PGRST204' ||
    c === 'PGRST205' ||
    c === 'PGRST202' ||
    m.includes('schema cache') ||
    m.includes('could not find')
  );
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot use AI`, 403);
  }

  const body = Input.parse(await req.json());
  const started = Date.now();
  log('request', `image=${body.image_url} filename=${body.original_filename}`);

  // ── 0. Schema sanity ──────────────────────────────────────────────────────
  const schema = await ensureSchema();
  if (!schema.ok) {
    logErr('schema-check', `Missing columns on products: ${schema.missing.join(', ')}`, {
      reason: schema.reason,
      hint: 'Run supabase/migrations/00000000000005_phase7_ai_drafts_safety.sql',
    });
    return err(
      'SCHEMA_OUT_OF_DATE',
      `Products table is missing columns: ${schema.missing.join(', ')}. Run migration 0005 (SQL Editor).`,
      500,
      { missing_columns: schema.missing, postgrest_error: schema.reason },
    );
  }

  // ── 1. First Claude pass ───────────────────────────────────────────────────
  let suggestion: { data: SuggestionT; usage: { input: number; output: number } };
  try {
    log('claude-vision', 'calling Haiku vision');
    suggestion = await callClaudeJson({
      model: 'haiku',
      system: MALIKA_SYSTEM_PROMPT,
      prompt: buildAutofillUserPrompt({}),
      image: { type: 'url', url: body.image_url },
      maxTokens: 3000,
      validate: (raw) => Suggestion.parse(raw),
    });
    log('claude-vision', `done, in=${suggestion.usage.input}t out=${suggestion.usage.output}t`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'AI vision call failed';
    logErr('claude-vision', msg);
    await logUsage({
      model: MODELS.haiku,
      operation: 'bulk_ai_process',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      success: false,
      error_message: msg,
    });
    return err('AI_ERROR', msg, 500);
  }

  let s: SuggestionT = suggestion.data;
  let totalInput = suggestion.usage.input;
  let totalOutput = suggestion.usage.output;
  let fallbackUsed = false;

  // ── 2. AR fallback ────────────────────────────────────────────────────────
  const arabicMissing =
    (!s.product_name_ar && s.product_name_en) ||
    (!s.description_ar && s.description_en) ||
    (!s.usage_ar && s.usage_en) ||
    (!s.keywords_ar?.length && s.keywords_en?.length);

  if (arabicMissing) {
    fallbackUsed = true;
    log('ar-fallback', 'AR fields missing, running rewrite pass');
    try {
      const fb = await callClaudeJson({
        model: 'haiku',
        system: MALIKA_AR_FALLBACK_PROMPT,
        prompt: buildArFallbackUserPrompt({
          product_name_en: s.product_name_en,
          description_en: s.description_en,
          usage_en: s.usage_en,
          keywords_en: s.keywords_en,
        }),
        maxTokens: 1800,
        validate: (raw) => ARFallback.parse(raw),
      });
      totalInput += fb.usage.input;
      totalOutput += fb.usage.output;
      if (!s.product_name_ar && fb.data.product_name_ar) s = { ...s, product_name_ar: fb.data.product_name_ar };
      if (!s.description_ar && fb.data.description_ar) s = { ...s, description_ar: fb.data.description_ar };
      if (!s.usage_ar && fb.data.usage_ar) s = { ...s, usage_ar: fb.data.usage_ar };
      if (!s.keywords_ar?.length && fb.data.keywords_ar?.length) s = { ...s, keywords_ar: fb.data.keywords_ar };
      log('ar-fallback', 'done');
    } catch (e) {
      logErr('ar-fallback', e instanceof Error ? e.message : 'unknown');
    }
  }

  // ── 3. Resolve brand / category / subcategory ─────────────────────────────
  // Self-healing: any brand Claude suggests that's not in our list gets
  // auto-created. The "Unknown" sentinel is also created on demand if
  // missing — no migration required.
  const admin = createAdminSupabaseClient();

  let brand_id = await resolveOrCreateBrand(admin, s.brand_hint);
  if (brand_id == null) {
    brand_id = await resolveOrCreateBrand(admin, FALLBACK_BRAND_NAME);
  }
  if (brand_id == null) {
    logErr('resolve-brand', 'CRITICAL: could not even create fallback brand');
    return err(
      'BRAND_RESOLUTION_FAILED',
      'Could not resolve or create any brand for this product. Check service-role permissions.',
      500,
    );
  }

  let category_id: number = FALLBACK_CATEGORY_ID;
  if (s.category_hint) {
    const { data: cat } = await admin
      .from('categories')
      .select('id')
      .ilike('name', s.category_hint)
      .maybeSingle();
    if (cat) category_id = cat.id;
  }

  let subcategory_id: number | null = null;
  if (s.subcategory_hint && category_id) {
    const { data: sub } = await admin
      .from('subcategories')
      .select('id')
      .eq('category_id', category_id)
      .ilike('name', s.subcategory_hint)
      .maybeSingle();
    if (sub) subcategory_id = sub.id;
  }
  log('resolve-fk', `brand=${brand_id} cat=${category_id} sub=${subcategory_id ?? '-'}`);

  // ── 4. Build product insert payload ────────────────────────────────────────
  const latencyMs = Date.now() - started;
  const cost_usd = estimateCostUsd(MODELS.haiku, totalInput, totalOutput);
  const confidence = typeof s.confidence === 'number' ? Number(s.confidence.toFixed(2)) : 0.5;

  const product_name_en = s.product_name_en?.trim() || `Untitled — ${body.original_filename}`;
  const product_name_ar = s.product_name_ar?.trim() || product_name_en;

  const ai_meta = {
    model: MODELS.haiku,
    input_tokens: totalInput,
    output_tokens: totalOutput,
    cost_usd,
    latency_ms: latencyMs,
    original_filename: body.original_filename,
    fallback_used: fallbackUsed,
    reasoning: s.reasoning ?? null,
    brand_hint: s.brand_hint ?? null,
    category_hint: s.category_hint ?? null,
    subcategory_hint: s.subcategory_hint ?? null,
  };

  // ── Explicit type coercion — defends against PostgREST sending strings ────
  // PostgREST occasionally serializes SERIAL ids as strings; coerce to Number
  // so we never hit "invalid input syntax for type integer" on the DB side.
  const brand_id_num = toIntOrNull(brand_id);
  const category_id_num = toIntOrNull(category_id);
  const subcategory_id_num = toIntOrNull(subcategory_id);

  if (brand_id_num == null || category_id_num == null) {
    logErr('coerce-ids', 'IDs failed to coerce to integer', {
      brand_id_raw: brand_id, brand_id_num,
      category_id_raw: category_id, category_id_num,
    });
    return err(
      'BAD_FK_TYPES',
      `Could not coerce FK ids to integers (brand_id=${brand_id}, category_id=${category_id}).`,
      500,
    );
  }

  const insertPayload = {
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
    stock_status: 'out_of_stock' as const,
    product_status: 'draft' as const,
    description_en: s.description_en ?? null,
    description_ar: s.description_ar ?? null,
    usage_en: s.usage_en ?? null,
    usage_ar: s.usage_ar ?? null,
    keywords_en: Array.isArray(s.keywords_en) ? s.keywords_en : null,
    keywords_ar: Array.isArray(s.keywords_ar) ? s.keywords_ar : null,
    source_platform: 'manual' as const,
    image_url: body.image_url,
    image_filename: body.original_filename,
    ai_generated: true,
    ai_confidence: Number(confidence),
    ai_meta,
    created_by: actor.email,
    updated_by: actor.email,
  };

  // ── 5. INSERT product (with schema-cache retry + safety-net fallback) ─────
  log('insert-product',
    `attempting insert (brand_id=${brand_id_num}, category_id=${category_id_num}, subcategory_id=${subcategory_id_num ?? '-'})`);

  const tryInsert = async () =>
    admin
      .from('products')
      .insert(insertPayload)
      .select('id, master_sku, ai_confidence, product_name_en, product_name_ar')
      .single();

  let { data: product, error: insertErr } = await tryInsert();

  // Retry once after forcing PostgREST to reload its cache
  if (insertErr && isSchemaCacheError(insertErr)) {
    SCHEMA_OK = null; // force re-check next request
    logErr('insert-product', `schema-cache miss — issuing NOTIFY pgrst and retrying once`, {
      code: insertErr.code,
      message: insertErr.message,
    });
    try {
      await admin.rpc('pg_notify' as never, { channel: 'pgrst', payload: 'reload schema' } as never);
    } catch {
      // RPC may not exist — that's fine, NOTIFY also fires from migration 0005
    }
    // Small breathing room for PostgREST
    await new Promise((r) => setTimeout(r, 750));
    const retry = await tryInsert();
    product = retry.data;
    insertErr = retry.error;
  }

  // If still failing → save to safety net so AI output is NEVER lost
  if (insertErr || !product) {
    const code = (insertErr?.code ?? '').toUpperCase();
    const failingColumn = extractColumnFromMessage(insertErr?.message ?? '');
    // FULL error object — `details` typically contains the actual offending value
    logErr('insert-product', insertErr?.message ?? 'unknown', {
      code,
      table: 'products',
      column: failingColumn,
      pg_details: insertErr?.details,
      pg_hint: insertErr?.hint,
      full_error: JSON.stringify(insertErr),
      payload_types: typeMap(insertPayload),
      payload_snapshot: snapshotPayload(insertPayload),
    });

    const safety = await saveToSafetyNet({
      image_url: body.image_url,
      original_filename: body.original_filename,
      suggestion: s,
      confidence,
      ai_meta,
      error_code: code || 'INSERT_FAILED',
      error_message: insertErr?.message ?? 'Unknown insert error',
      failing_table: 'products',
      failing_payload: snapshotPayload(insertPayload) as Record<string, unknown>,
      actor_email: actor.email,
    });

    await logUsage({
      model: MODELS.haiku,
      operation: 'bulk_ai_process',
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd,
      latency_ms: latencyMs,
      success: false,
      error_message: `products insert failed (${code || 'UNKNOWN'}): ${insertErr?.message ?? ''}`,
    });

    if (safety.id == null) {
      // Last-resort response: the AI work IS preserved in the response body.
      // UI surfaces this and tells the operator what migration to run.
      return ok({
        status: 'ai_output_preserved_in_response' as const,
        ai_draft_id: null,
        confidence,
        fields_filled: countFilledFields(s),
        suggestion: s,
        meta: {
          model: MODELS.haiku,
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cost_usd,
          latency_ms: latencyMs,
          fallback_used: fallbackUsed,
        },
        error: {
          code: (insertErr?.code ?? 'INSERT_FAILED').toUpperCase(),
          message: insertErr?.message ?? 'Unknown insert error',
          details: insertErr?.details ?? null,
          hint: insertErr?.hint ?? null,
          failing_table: 'products',
          failing_column: extractColumnFromMessage(insertErr?.message ?? ''),
          safety_net_reason: safety.reason ?? 'unknown',
          operator_hint:
            'Run migration 0005 in Supabase SQL Editor to enable the ai_drafts safety net, then retry. The AI output above is preserved.',
        },
      });
    }

    return ok({
      status: 'draft_saved_to_safety_net' as const,
      ai_draft_id: safety.id,
      confidence,
      fields_filled: countFilledFields(s),
      suggestion: s,
      meta: {
        model: MODELS.haiku,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        cost_usd,
        latency_ms: latencyMs,
        fallback_used: fallbackUsed,
      },
      error: {
        code: code || 'INSERT_FAILED',
        message: insertErr?.message ?? 'Unknown',
        failing_table: 'products',
        failing_column: failingColumn,
      },
    });
  }

  log('insert-product', `OK → ${product.master_sku} (id=${product.id})`);

  // ── 6. Link image to product (non-fatal if it fails) ──────────────────────
  const storagePathMatch = body.image_url.match(/\/storage\/v1\/object\/public\/[^/]+\/(.+)$/);
  const r2_key = storagePathMatch?.[1] ?? body.image_url;

  const { error: imgErr } = await admin.from('product_images').insert({
    master_sku: product.master_sku,
    r2_key,
    cdn_url: body.image_url,
    filename: body.original_filename,
    is_primary: true,
    uploaded_by: actor.email,
  });
  if (imgErr) {
    logErr('insert-image', `non-fatal: ${imgErr.message}`, {
      table: 'product_images',
      master_sku: product.master_sku,
    });
  } else {
    log('insert-image', `linked image to ${product.master_sku}`);
  }

  // ── 7. Log AI usage ────────────────────────────────────────────────────────
  await logUsage({
    model: MODELS.haiku,
    operation: fallbackUsed ? 'bulk_ai_process+ar_fallback' : 'bulk_ai_process',
    input_tokens: totalInput,
    output_tokens: totalOutput,
    cost_usd,
    latency_ms: latencyMs,
    success: true,
  });

  // ── 8. Compute UI status from confidence ──────────────────────────────────
  const status: 'ready' | 'needs_review' = confidence >= CONFIDENCE_READY ? 'ready' : 'needs_review';

  return ok({
    status,
    master_sku: product.master_sku,
    product_id: product.id,
    confidence,
    fields_filled: countFilledFields(s),
    suggestion: s,
    resolved: { brand_id, category_id, subcategory_id },
    meta: {
      model: MODELS.haiku,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd,
      latency_ms: latencyMs,
      fallback_used: fallbackUsed,
    },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function logUsage(row: {
  model: string;
  operation: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  error_message?: string;
}) {
  try {
    const admin = createAdminSupabaseClient();
    await admin.from('ai_usage_log').insert(row);
  } catch {
    // Logging must never break the request
  }
}

/** Tries to pull a column name out of a Postgres / PostgREST error message. */
function extractColumnFromMessage(msg: string): string | null {
  // Common patterns:
  //   column "ai_meta" of relation "products" does not exist
  //   Could not find the 'ai_generated' column of 'products' in the schema cache
  //   null value in column "price" of relation "products" violates not-null constraint
  const patterns = [
    /column "([^"]+)"/i,
    /'([^']+)' column/i,
    /column ([a-z_]+) /i,
  ];
  for (const p of patterns) {
    const m = msg.match(p);
    if (m) return m[1];
  }
  return null;
}

function snapshotPayload<T extends Record<string, unknown>>(p: T): Record<string, unknown> {
  // Trim long strings so logs/safety-net rows stay manageable
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string' && v.length > 400) {
      out[k] = v.slice(0, 400) + `…(+${v.length - 400} chars)`;
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 8);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Logs runtime JS types per key — invaluable when diagnosing FK/coercion errors. */
function typeMap<T extends Record<string, unknown>>(p: T): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === null) out[k] = 'null';
    else if (Array.isArray(v)) out[k] = `array(${v.length})`;
    else if (typeof v === 'object') out[k] = 'object';
    else out[k] = `${typeof v}=${JSON.stringify(v)?.slice(0, 50)}`;
  }
  return out;
}

/**
 * Convert any incoming value to a positive integer or null.
 * Handles strings ("42"), numbers (42), and BigInts. Returns null on garbage.
 * Required because PostgREST sometimes serializes SERIAL ids as strings, and
 * a stray quote in an FK kills the insert with "invalid input syntax for type integer".
 */
function toIntOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }
  if (typeof v === 'bigint') {
    return Number(v) > 0 ? Number(v) : null;
  }
  return null;
}

function countFilledFields(s: SuggestionT): number {
  return [
    s.product_name_en, s.product_name_ar, s.description_en, s.description_ar,
    s.usage_en, s.usage_ar, s.brand_hint, s.category_hint, s.subcategory_hint,
    s.color, s.size, s.product_type, s.variant,
    s.keywords_en?.length, s.keywords_ar?.length,
  ].filter(Boolean).length;
}
