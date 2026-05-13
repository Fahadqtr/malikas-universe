/**
 * POST /api/ai/autofill
 *
 * Body:
 *   {
 *     image_url: string (required)
 *     brand_hint?: string
 *     category_hint?: string
 *   }
 *
 * Returns bilingual product fields in Malika Style Mode — Snoonu/Talabat
 * marketplace format (not Sephora editorial). See lib/ai-prompts.ts.
 *
 * Hard rules: never invent price/stock; never make medical claims;
 *             AR is fresh marketplace Arabic, not literal translation;
 *             ✔️ for EN bullets, 🔸 for AR bullets.
 *
 * Fallback: if Claude omits any AR field, a second pass rewrites the EN
 *           content into Malika-style Gulf Arabic.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { callClaudeJson, estimateCostUsd, MODELS } from '@/lib/claude';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import {
  MALIKA_STYLE_MODE,
  DEFAULT_STYLE_MODE,
  MALIKA_SYSTEM_PROMPT,
  MALIKA_AR_FALLBACK_PROMPT,
  buildAutofillUserPrompt,
  buildArFallbackUserPrompt,
} from '@/lib/ai-prompts';

const Input = z.object({
  image_url: z.string().url(),
  brand_hint: z.string().optional(),
  category_hint: z.string().optional(),
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

export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot use AI`, 403);
  }

  const body = Input.parse(await req.json());
  const styleMode = DEFAULT_STYLE_MODE; // = MALIKA_STYLE_MODE

  const userPrompt = buildAutofillUserPrompt({
    brand_hint: body.brand_hint,
    category_hint: body.category_hint,
  });

  const started = Date.now();

  // First pass: Malika-style bilingual generation
  let suggestion;
  try {
    suggestion = await callClaudeJson({
      model: 'haiku',
      system: MALIKA_SYSTEM_PROMPT,
      prompt: userPrompt,
      image: { type: 'url', url: body.image_url },
      maxTokens: 3000, // Higher to fit full bullet-formatted bilingual block
      validate: (raw) => Suggestion.parse(raw),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'AI call failed';
    return err('AI_ERROR', msg, 500);
  }

  let s: SuggestionT = suggestion.data;
  let totalInput = suggestion.usage.input;
  let totalOutput = suggestion.usage.output;
  let fallbackTriggered = false;

  // Fallback: if any AR field empty while EN exists, rewrite fresh in AR
  const arabicMissing =
    (!s.product_name_ar && s.product_name_en) ||
    (!s.description_ar && s.description_en) ||
    (!s.usage_ar && s.usage_en) ||
    (!s.keywords_ar?.length && s.keywords_en?.length);

  if (arabicMissing) {
    fallbackTriggered = true;
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
    } catch {
      // Fallback failure is non-fatal
    }
  }

  const latencyMs = Date.now() - started;
  const admin = createAdminSupabaseClient();

  void admin
    .from('ai_usage_log')
    .insert({
      model: MODELS.haiku,
      operation: fallbackTriggered ? 'autofill+ar_fallback' : 'autofill',
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cost_usd: estimateCostUsd(MODELS.haiku, totalInput, totalOutput),
      latency_ms: latencyMs,
      success: true,
    })
    .then(() => undefined);

  // Resolve brand_hint → brand_id
  let resolved_brand_id: number | null = null;
  if (s.brand_hint) {
    const { data: brand } = await admin
      .from('brands')
      .select('id')
      .ilike('name', s.brand_hint)
      .maybeSingle();
    if (brand) resolved_brand_id = brand.id;
  }

  // Resolve category_hint → category_id
  let resolved_category_id: number | null = null;
  if (s.category_hint) {
    const { data: cat } = await admin
      .from('categories')
      .select('id')
      .ilike('name', s.category_hint)
      .maybeSingle();
    if (cat) resolved_category_id = cat.id;
  }

  // Resolve subcategory_hint within parent category
  let resolved_subcategory_id: number | null = null;
  if (s.subcategory_hint && resolved_category_id) {
    const { data: sub } = await admin
      .from('subcategories')
      .select('id')
      .eq('category_id', resolved_category_id)
      .ilike('name', s.subcategory_hint)
      .maybeSingle();
    if (sub) resolved_subcategory_id = sub.id;
  }

  return ok({
    suggestion: s,
    resolved: {
      brand_id: resolved_brand_id,
      category_id: resolved_category_id,
      subcategory_id: resolved_subcategory_id,
    },
    meta: {
      style_mode: styleMode,
      model: MODELS.haiku,
      latency_ms: latencyMs,
      tokens: { input: totalInput, output: totalOutput },
      estimated_cost_usd: estimateCostUsd(MODELS.haiku, totalInput, totalOutput),
      fallback_used: fallbackTriggered,
    },
  });
});

// Re-export the style constant for any other route that wants to reference it
export { MALIKA_STYLE_MODE };
