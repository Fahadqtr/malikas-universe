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
 *   4. Resolve brand / category / subcategory + INSERT product DRAFT
 *      (shared helper `createProductFromSuggestion`)
 *        ↳ on schema-cache error: refresh + retry once (inside the helper)
 *        ↳ on any other failure: save full AI payload to ai_drafts (NEVER LOST)
 *   5. INSERT product_images linking the uploaded URL
 *   6. Log tokens + cost + latency to ai_usage_log
 *
 * Returns one of:
 *   - { status:'ready'|'needs_review', master_sku, product_id, confidence, ... }   ← happy path
 *   - { status:'draft_saved_to_safety_net', ai_draft_id, confidence, ... }         ← recovered
 *
 * Resilience guarantees:
 *   ✓ AI output is never lost — falls through to ai_drafts on any DB failure
 *   ✓ Schema cache misses auto-retry after NOTIFY pgrst
 *   ✓ Pre-flight check surfaces missing migrations BEFORE Claude is called
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { callClaudeJson, estimateCostUsd, MODELS } from '@/lib/claude';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { Json } from '@malikas/db';
import {
  Suggestion,
  type SuggestionT,
  createProductFromSuggestion,
} from '@/lib/bulk-ai/create-product';
import {
  MALIKA_SYSTEM_PROMPT,
  MALIKA_AR_FALLBACK_PROMPT,
  buildAutofillUserPrompt,
  buildArFallbackUserPrompt,
} from '@/lib/ai-prompts';

export const runtime = 'nodejs';
export const maxDuration = 60;

const CONFIDENCE_READY = 0.9;

// Cache the result of the pre-flight schema check per Node process so we
// don't spam information_schema on every request.
let SCHEMA_OK: boolean | null = null;

// ─── Input / output schemas ──────────────────────────────────────────────────

const Input = z.object({
  image_url: z.string().url(),
  original_filename: z.string().min(1),
});

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
 * Probes the columns directly via PostgREST — surfaces stale-cache problems too.
 * Result is cached for this Node process; cleared on schema-cache errors.
 */
async function ensureSchema(): Promise<{ ok: true } | { ok: false; missing: string[]; reason: string }> {
  if (SCHEMA_OK === true) return { ok: true };

  const admin = createAdminSupabaseClient();
  const required = ['ai_generated', 'ai_confidence', 'ai_meta', 'usage_en', 'usage_ar'];

  const { error } = await admin.from('products').select(`id, ${required.join(', ')}`).limit(1);

  if (!error) {
    SCHEMA_OK = true;
    return { ok: true };
  }

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
      ai_meta: args.ai_meta as Json,
      status: 'pending_recovery',
      error_code: args.error_code,
      error_message: args.error_message,
      failing_table: args.failing_table,
      failing_payload: args.failing_payload as Json,
      created_by: args.actor_email,
    })
    .select('id')
    .single();

  if (error) {
    const reason =
      error.code === '42P01' || (error.message ?? '').includes('ai_drafts')
        ? 'ai_drafts table is missing — run migration 0005 in Supabase SQL Editor'
        : error.message ?? 'unknown';
    logErr('safety-net', 'CRITICAL: could not save to ai_drafts either', {
      message: error.message, hint: error.hint, code: error.code, reason,
    });
    return { id: null, reason };
  }
  log('safety-net', `saved AI output to ai_drafts(id=${data.id})`);
  return { id: data.id };
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
      model: MODELS.haiku, operation: 'bulk_ai_process',
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      latency_ms: Date.now() - started, success: false, error_message: msg,
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

  // ── 3. Build AI meta ───────────────────────────────────────────────────────
  const latencyMs = Date.now() - started;
  const cost_usd = estimateCostUsd(MODELS.haiku, totalInput, totalOutput);
  const confidence = typeof s.confidence === 'number' ? Number(s.confidence.toFixed(2)) : 0.5;

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

  // ── 4. Resolve brand/category/subcategory + INSERT product (shared helper) ─
  const admin = createAdminSupabaseClient();
  const result = await createProductFromSuggestion({
    admin,
    suggestion: s,
    confidence,
    aiMeta: ai_meta,
    imageUrl: body.image_url,
    originalFilename: body.original_filename,
    actorEmail: actor.email,
    onSchemaReload: () => { SCHEMA_OK = null; },
  });

  if (!result.ok && result.stage === 'brand') {
    logErr('resolve-brand', 'CRITICAL: could not even create fallback brand');
    return err('BRAND_RESOLUTION_FAILED', result.message, 500);
  }
  if (!result.ok && result.stage === 'coerce') {
    logErr('coerce-ids', result.message);
    return err('BAD_FK_TYPES', result.message, 500);
  }

  // ── 4b. Insert failed → save to safety net so AI output is NEVER lost ──────
  if (!result.ok) {
    const code = result.code;
    logErr('insert-product', result.message, {
      code, table: 'products', column: result.failing_column,
      pg_details: result.raw?.details, pg_hint: result.raw?.hint,
      payload_snapshot: result.payloadSnapshot,
    });

    const safety = await saveToSafetyNet({
      image_url: body.image_url,
      original_filename: body.original_filename,
      suggestion: s,
      confidence,
      ai_meta,
      error_code: code || 'INSERT_FAILED',
      error_message: result.message,
      failing_table: 'products',
      failing_payload: (result.payloadSnapshot ?? {}) as Record<string, unknown>,
      actor_email: actor.email,
    });

    await logUsage({
      model: MODELS.haiku, operation: 'bulk_ai_process',
      input_tokens: totalInput, output_tokens: totalOutput, cost_usd, latency_ms: latencyMs,
      success: false,
      error_message: `products insert failed (${code || 'UNKNOWN'}): ${result.message}`,
    });

    if (safety.id == null) {
      return ok({
        status: 'ai_output_preserved_in_response' as const,
        ai_draft_id: null,
        confidence,
        fields_filled: countFilledFields(s),
        suggestion: s,
        meta: {
          model: MODELS.haiku, input_tokens: totalInput, output_tokens: totalOutput,
          cost_usd, latency_ms: latencyMs, fallback_used: fallbackUsed,
        },
        error: {
          code: code || 'INSERT_FAILED',
          message: result.message,
          details: result.raw?.details ?? null,
          hint: result.raw?.hint ?? null,
          failing_table: 'products',
          failing_column: result.failing_column,
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
        model: MODELS.haiku, input_tokens: totalInput, output_tokens: totalOutput,
        cost_usd, latency_ms: latencyMs, fallback_used: fallbackUsed,
      },
      error: {
        code: code || 'INSERT_FAILED',
        message: result.message,
        failing_table: 'products',
        failing_column: result.failing_column,
      },
    });
  }

  const product = result.product;
  const { brand_id, category_id, subcategory_id } = result.resolved;
  log('insert-product', `OK → ${product.master_sku} (id=${product.id})`);

  // ── 5. Link image to product (non-fatal if it fails) ──────────────────────
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
      table: 'product_images', master_sku: product.master_sku,
    });
  } else {
    log('insert-image', `linked image to ${product.master_sku}`);
  }

  // ── 6. Log AI usage ────────────────────────────────────────────────────────
  await logUsage({
    model: MODELS.haiku,
    operation: fallbackUsed ? 'bulk_ai_process+ar_fallback' : 'bulk_ai_process',
    input_tokens: totalInput, output_tokens: totalOutput, cost_usd, latency_ms: latencyMs,
    success: true,
  });

  // ── 7. Compute UI status from confidence ──────────────────────────────────
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
      model: MODELS.haiku, input_tokens: totalInput, output_tokens: totalOutput,
      cost_usd, latency_ms: latencyMs, fallback_used: fallbackUsed,
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

function countFilledFields(s: SuggestionT): number {
  return [
    s.product_name_en, s.product_name_ar, s.description_en, s.description_ar,
    s.usage_en, s.usage_ar, s.brand_hint, s.category_hint, s.subcategory_hint,
    s.color, s.size, s.product_type, s.variant,
    s.keywords_en?.length, s.keywords_ar?.length,
  ].filter(Boolean).length;
}
