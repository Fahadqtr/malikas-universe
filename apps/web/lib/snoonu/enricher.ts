/**
 * AI enrichment + image quality checker — Phase 13.10.
 *
 * Given a partially-extracted Snoonu product, ask Claude to fill in the gaps:
 *   - name_ar (when only name_en was scraped)
 *   - description_en / description_ar
 *   - keywords_en / keywords_ar
 *   - product_type / subcategory
 *
 * Plus: a vision-based image quality scorer that flags:
 *   - low_resolution    (under 800x800)
 *   - not_square        (aspect off by more than 2%)
 *   - non_white_bg      (background isn't white — bad for Snoonu)
 *   - watermark         (visible text/logo overlay)
 *   - blurry            (low sharpness)
 *   - low_contrast      (washed out)
 *
 * Both functions are pure: no DB writes. The caller decides what to do
 * with the result (store in snoonu_import_items.raw_payload.enriched,
 * or surface it in the review UI).
 *
 * Cost guard: only run on items the operator has flagged for create_new
 * or items missing critical bilingual fields.
 */

import { z } from 'zod';
import { callClaudeJson, type ImageInput } from '@/lib/claude';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EnrichmentInput = {
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  category: string;             // master category we inferred
  product_type: string | null;
  description_en: string | null;
  description_ar: string | null;
  price?: number | null;
  variants?: Array<{ variant_type: string; variant_value: string }>;
};

export type Enrichment = {
  name_en: string;
  name_ar: string;
  description_en: string;
  description_ar: string;
  keywords_en: string[];
  keywords_ar: string[];
  product_type: string | null;
  subcategory: string | null;
  filled_fields: string[];      // which fields the AI populated
  confidence: number;           // 0..1
};

export type ImageQualityReport = {
  ok: boolean;
  score: number;                // 0..1, 1 = perfect for marketplace
  issues: ImageQualityIssue[];
  notes: string | null;
};

export type ImageQualityIssue =
  | 'low_resolution'
  | 'not_square'
  | 'non_white_bg'
  | 'watermark'
  | 'blurry'
  | 'low_contrast'
  | 'multiple_products'
  | 'placeholder';

// ─── Zod schemas (Claude output shape) ──────────────────────────────────────

const EnrichmentSchema = z.object({
  name_en: z.string().min(2),
  name_ar: z.string().min(2),
  description_en: z.string().min(20),
  description_ar: z.string().min(20),
  keywords_en: z.array(z.string()).min(3).max(15),
  keywords_ar: z.array(z.string()).min(3).max(15),
  product_type: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
});

const ImageReportSchema = z.object({
  score: z.number().min(0).max(1),
  issues: z.array(
    z.enum([
      'low_resolution',
      'not_square',
      'non_white_bg',
      'watermark',
      'blurry',
      'low_contrast',
      'multiple_products',
      'placeholder',
    ]),
  ),
  notes: z.string().nullable().optional(),
});

// ─── Prompts ────────────────────────────────────────────────────────────────

const ENRICH_SYSTEM = `You are the Malika Style copywriter for a Qatar K-beauty marketplace.

Output rules:
- Bilingual (English + Arabic). Arabic must be natural, NOT machine-translated.
- Marketplace tone: clean, premium, benefit-led. NO emojis unless data has them.
- Names: "[Brand] [Product Name] [Size/Variant]" pattern when applicable.
- Descriptions: 2-4 short lines. Each line a clear benefit or fact. No fluff.
- Keywords: 5-10 search terms a Qatari customer would type. Include brand,
  product type, hero ingredient, skin concern, language variations.
- NEVER invent ingredients, certifications, medical claims, or stock numbers.

Subcategories for Korean Skincare:
  Cleanser, Toner, Essence, Serum, Ampoule, Moisturizer, Sunscreen,
  Sheet Mask, Sleeping Mask, Eye Cream, Exfoliator.

Output: strict JSON matching the schema. Do not wrap in markdown.`;

function buildEnrichPrompt(input: EnrichmentInput): string {
  const variantBlock =
    input.variants && input.variants.length > 0
      ? `\nVariants present: ${input.variants.map((v) => `${v.variant_type}=${v.variant_value}`).join(', ')}`
      : '';

  return `Fill in any missing fields for this product. Keep existing values unless they're empty or obviously wrong.

Current data:
- Brand: ${input.brand ?? '(unknown)'}
- Category: ${input.category}
- Product type: ${input.product_type ?? '(unknown)'}
- Name (EN): ${input.name_en ?? '(missing)'}
- Name (AR): ${input.name_ar ?? '(missing)'}
- Description (EN): ${input.description_en ?? '(missing)'}
- Description (AR): ${input.description_ar ?? '(missing)'}
- Price: ${input.price != null ? `${input.price} QAR` : '(unknown)'}${variantBlock}

Output JSON:
{
  "name_en": "...",
  "name_ar": "...",
  "description_en": "...",
  "description_ar": "...",
  "keywords_en": ["..."],
  "keywords_ar": ["..."],
  "product_type": "..." or null,
  "subcategory": "..." or null,
  "confidence": 0.0-1.0
}`;
}

const IMAGE_QC_SYSTEM = `You are a marketplace image QC reviewer for Snoonu/Talabat/Rafeeq listings.

Marketplace requirements:
- Square aspect (1:1)
- White or very light neutral background
- Single product, clearly visible
- No watermarks, logos overlaying, or store branding
- Sharp focus, good contrast

Score the image on a 0-1 scale where:
  1.0  = ready to publish on Snoonu
  0.7  = usable but some flaws
  0.4  = needs reshoot/edit
  0.0  = unusable / placeholder

List every issue that applies. Be strict — Snoonu rejects images with watermarks.

Output: strict JSON only.`;

const IMAGE_QC_PROMPT = `Score this product image. Return JSON:
{
  "score": 0.0-1.0,
  "issues": ["low_resolution" | "not_square" | "non_white_bg" | "watermark" | "blurry" | "low_contrast" | "multiple_products" | "placeholder"],
  "notes": "one-line summary or null"
}`;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enrich missing fields for an extracted product using Claude Haiku.
 *
 * @returns Enrichment payload + list of fields that were filled (vs. kept).
 */
export async function enrichExtractedProduct(
  input: EnrichmentInput,
): Promise<{ data: Enrichment; usage: { input: number; output: number } }> {
  const result = await callClaudeJson({
    model: 'haiku',
    system: ENRICH_SYSTEM,
    prompt: buildEnrichPrompt(input),
    maxTokens: 1500,
    validate: (raw) => EnrichmentSchema.parse(raw),
  });

  const filled: string[] = [];
  if (!input.name_en && result.data.name_en) filled.push('name_en');
  if (!input.name_ar && result.data.name_ar) filled.push('name_ar');
  if (!input.description_en && result.data.description_en) filled.push('description_en');
  if (!input.description_ar && result.data.description_ar) filled.push('description_ar');
  if (result.data.keywords_en.length > 0) filled.push('keywords_en');
  if (result.data.keywords_ar.length > 0) filled.push('keywords_ar');
  if (!input.product_type && result.data.product_type) filled.push('product_type');
  if (result.data.subcategory) filled.push('subcategory');

  return {
    data: {
      ...result.data,
      product_type: result.data.product_type ?? null,
      subcategory: result.data.subcategory ?? null,
      filled_fields: filled,
    },
    usage: result.usage,
  };
}

/**
 * Vision-based image quality check. Pass a public image URL (preferred) or
 * a base64 blob if you already downloaded it.
 *
 * Marketplace-grade verdict + scored issue list.
 */
export async function scoreImageQuality(
  image: ImageInput,
  opts: { dims?: { width: number; height: number } | null } = {},
): Promise<{ data: ImageQualityReport; usage: { input: number; output: number } }> {
  const result = await callClaudeJson({
    model: 'haiku',
    system: IMAGE_QC_SYSTEM,
    prompt: IMAGE_QC_PROMPT,
    image,
    maxTokens: 400,
    validate: (raw) => ImageReportSchema.parse(raw),
  });

  // Cross-check the AI's "not_square" / "low_resolution" flags against actual dims
  // when we have them — local truth beats vision guesses for measurable things.
  const issues = new Set<ImageQualityIssue>(result.data.issues);
  if (opts.dims) {
    const { width, height } = opts.dims;
    const aspect = Math.abs(width - height) / Math.max(width, height);
    if (aspect > 0.02) issues.add('not_square');
    else issues.delete('not_square');
    if (width < 800 || height < 800) issues.add('low_resolution');
    else issues.delete('low_resolution');
  }

  return {
    data: {
      ok: result.data.score >= 0.7 && issues.size === 0,
      score: result.data.score,
      issues: Array.from(issues),
      notes: result.data.notes ?? null,
    },
    usage: result.usage,
  };
}

/**
 * Cheap, no-AI dimensions-only check. Use this in the extraction pipeline
 * to flag obvious issues before deciding whether to spend AI tokens.
 */
export function quickImageCheck(opts: {
  width: number | null;
  height: number | null;
  size_bytes: number;
}): { issues: ImageQualityIssue[]; needs_ai_review: boolean } {
  const issues: ImageQualityIssue[] = [];
  let needsAi = false;

  if (opts.width != null && opts.height != null) {
    if (opts.width < 800 || opts.height < 800) issues.push('low_resolution');
    const aspect = Math.abs(opts.width - opts.height) / Math.max(opts.width, opts.height);
    if (aspect > 0.02) issues.push('not_square');
  } else {
    needsAi = true; // unknown dims — let AI judge
  }

  // Tiny file likely = placeholder/icon
  if (opts.size_bytes < 8 * 1024) issues.push('placeholder');

  // White background / watermark only the AI can judge
  if (issues.length === 0) needsAi = true;

  return { issues, needs_ai_review: needsAi };
}
