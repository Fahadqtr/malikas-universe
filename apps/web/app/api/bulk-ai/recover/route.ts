/**
 * Bulk-AI recovery — Phase 1 (backend).
 *
 * GET  /api/bulk-ai/recover
 *   Lists ai_drafts still in status='pending_recovery' (newest first, paginated)
 *   so an owner/editor can review AI output that failed to become a product.
 *
 * POST /api/bulk-ai/recover
 *   Body: { draftId, overrides? } — converts ONE pending draft into a real
 *   product. The route only validates + prepares the product payload (no AI),
 *   then delegates the actual write to the transactional RPC
 *   `public.recover_ai_draft`, which inserts the product and marks the draft
 *   recovered inside a SINGLE PostgreSQL transaction (FOR UPDATE on the draft).
 *
 * Idempotency / atomicity is guaranteed by the DB function — NOT by the app:
 *   * FOR UPDATE serializes concurrent recoveries of the same draft.
 *   * INSERT product + UPDATE ai_drafts are one transaction (rollback of both
 *     on any error → no orphan product, no partial finalize).
 *   * A retry of an already-recovered draft returns the existing product; no
 *     second product is ever created (fixes the old recovered_at+TTL race).
 *
 * Owner/editor only (ROLE_SETS.writers). Never calls Claude / any AI.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import type { Json } from '@malikas/db';
import { Suggestion, prepareProductFromSuggestion } from '@/lib/bulk-ai/create-product';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

// Only the fields the review UI needs — no created_by / recovered_* leakage.
const DRAFT_LIST_COLUMNS =
  'id, image_url, original_filename, suggestion, confidence, ai_meta, error_code, error_message, failing_table, failing_payload, created_at';

// ─── GET: list pending_recovery drafts ────────────────────────────────────────

export const GET = withErrorHandling(async (req: NextRequest) => {
  await requireActor(ROLE_SETS.writers);

  const sp = req.nextUrl.searchParams;
  const limit = clampInt(sp.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(sp.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  const admin = createAdminSupabaseClient();
  const { data, count, error } = await admin
    .from('ai_drafts')
    .select(DRAFT_LIST_COLUMNS, { count: 'exact' })
    .eq('status', 'pending_recovery')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[bulk-ai/recover] list failed', error);
    return err('RECOVER_LIST_FAILED', 'Could not load recovery drafts', 500);
  }

  return ok({ items: data ?? [], total: count ?? 0, limit, offset });
});

// ─── POST: recover one draft → product (via transactional RPC) ────────────────

const Overrides = z
  .object({
    brandId: z.number().int().positive().optional(),
    brandName: z.string().min(1).max(120).optional(),
    categoryId: z.number().int().positive().optional(),
    subcategoryId: z.number().int().positive().optional(),
    productNameEn: z.string().min(1).max(300).optional(),
    productNameAr: z.string().min(1).max(300).optional(),
    descriptionEn: z.string().max(4000).optional(),
    descriptionAr: z.string().max(4000).optional(),
    usageEn: z.string().max(4000).optional(),
    usageAr: z.string().max(4000).optional(),
  })
  .strict();

const RecoverBody = z.object({
  draftId: z.number().int().positive(),
  overrides: Overrides.optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await requireActor(ROLE_SETS.writers);
  if (!actor.id) return err('UNAUTHORIZED', 'Authenticated actor id is required', 401);

  // 1. Validate body
  const parsed = RecoverBody.safeParse(await req.json());
  if (!parsed.success) {
    return err('BAD_REQUEST', 'draftId (positive integer) is required', 400, { issues: parsed.error.issues });
  }
  const { draftId, overrides } = parsed.data;

  const admin = createAdminSupabaseClient();

  // 2. Load the draft (needed to build the payload + branch on status)
  const { data: draft, error: loadErr } = await admin
    .from('ai_drafts')
    .select('id, status, suggestion, confidence, ai_meta, image_url, original_filename, recovered_master_sku')
    .eq('id', draftId)
    .maybeSingle();

  if (loadErr) {
    console.error('[bulk-ai/recover] load failed', loadErr);
    return err('RECOVER_LOAD_FAILED', 'Could not load the draft', 500);
  }
  if (!draft) return err('DRAFT_NOT_FOUND', `Draft ${draftId} not found`, 404);

  // The transactional RPC is the atomic source of truth. For a PENDING draft we
  // validate + prepare a product payload; for an ALREADY-recovered draft we send
  // an empty payload and let the RPC return the existing product (or flag an
  // inconsistency). Any other status is not recoverable.
  let payload: Json = {};
  let resolved: { brand_id: number; category_id: number; subcategory_id: number | null } | null = null;

  if (draft.status === 'pending_recovery') {
    // Validate the stored suggestion
    const sugg = Suggestion.safeParse(draft.suggestion);
    if (!sugg.success) {
      return err('INVALID_SUGGESTION', 'Stored draft suggestion is not a valid product suggestion', 422, {
        issues: sugg.error.issues,
      });
    }

    // Validate overrides that reference existing rows (never trust unknown ids)
    if (overrides?.brandId != null) {
      const { data: b } = await admin.from('brands').select('id').eq('id', overrides.brandId).maybeSingle();
      if (!b) return err('BAD_BRAND', `Brand ${overrides.brandId} not found`, 400);
    }
    if (overrides?.categoryId != null) {
      const { data: c } = await admin.from('categories').select('id').eq('id', overrides.categoryId).maybeSingle();
      if (!c) return err('BAD_CATEGORY', `Category ${overrides.categoryId} not found`, 400);
    }
    if (overrides?.subcategoryId != null) {
      const { data: sc } = await admin
        .from('subcategories').select('id, category_id').eq('id', overrides.subcategoryId).maybeSingle();
      if (!sc) return err('BAD_SUBCATEGORY', `Subcategory ${overrides.subcategoryId} not found`, 400);
      if (overrides.categoryId != null && sc.category_id !== overrides.categoryId) {
        return err('BAD_SUBCATEGORY', `Subcategory ${overrides.subcategoryId} does not belong to category ${overrides.categoryId}`, 400);
      }
    }

    // Merge text overrides over the suggestion (never drop the other AI fields)
    const merged = {
      ...sugg.data,
      product_name_en: overrides?.productNameEn ?? sugg.data.product_name_en,
      product_name_ar: overrides?.productNameAr ?? sugg.data.product_name_ar,
      description_en: overrides?.descriptionEn ?? sugg.data.description_en,
      description_ar: overrides?.descriptionAr ?? sugg.data.description_ar,
      usage_en: overrides?.usageEn ?? sugg.data.usage_en,
      usage_ar: overrides?.usageAr ?? sugg.data.usage_ar,
    };

    const baseMeta =
      draft.ai_meta && typeof draft.ai_meta === 'object' && !Array.isArray(draft.ai_meta)
        ? (draft.ai_meta as Record<string, unknown>)
        : {};
    const aiMeta: Record<string, unknown> = {
      ...baseMeta,
      recovered_from_draft_id: draftId,
      recovered_by: actor.email,
    };

    // Prepare the product payload (resolve brand/category, defaults) — NO insert
    const prep = await prepareProductFromSuggestion({
      admin,
      suggestion: merged,
      overrides: {
        brandId: overrides?.brandId ?? null,
        brandName: overrides?.brandName ?? null,
        categoryId: overrides?.categoryId ?? null,
        subcategoryId: overrides?.subcategoryId ?? null,
      },
      confidence: typeof draft.confidence === 'number' ? draft.confidence : 0.5,
      aiMeta,
      imageUrl: draft.image_url,
      originalFilename: draft.original_filename ?? draft.image_url,
    });

    if (!prep.ok) {
      console.error('[bulk-ai/recover] payload preparation failed', { draftId, stage: prep.stage, code: prep.code });
      return err('RECOVERY_PRODUCT_FAILED', `Could not prepare product from draft: ${prep.message}`, 500, {
        stage: prep.stage,
        failing_column: prep.failing_column,
      });
    }
    // ProductPayload is a fixed set of JSON-serializable columns. TS can't infer
    // the index signature Json needs, so bridge via unknown — the RPC name + all
    // other args stay fully type-checked (this is NOT an `as never` escape hatch).
    payload = prep.prepared.payload as unknown as Json;
    resolved = prep.prepared.resolved;
  } else if (draft.status !== 'recovered') {
    // 'dismissed' or anything else — the RPC would reject it too.
    return err('DRAFT_NOT_RECOVERABLE', `Draft ${draftId} is '${draft.status}', not pending_recovery`, 409);
  }
  // draft.status === 'recovered' → empty payload; the RPC returns the existing product.

  // Atomic recovery — the RPC inserts the product + finalizes the draft in ONE
  // transaction (or returns the already-recovered product). It is the single
  // source of truth for retries, concurrency and inconsistency.
  const { data: rpcData, error: rpcErr } = await admin.rpc('recover_ai_draft', {
    p_draft_id: draftId,
    p_actor_id: actor.id,
    p_actor_email: actor.email,
    p_product_payload: payload,
  });

  if (rpcErr) {
    const msg = rpcErr.message ?? '';
    if (msg.includes('DRAFT_NOT_FOUND')) return err('DRAFT_NOT_FOUND', `Draft ${draftId} not found`, 404);
    if (msg.includes('DRAFT_NOT_RECOVERABLE')) {
      return err('DRAFT_NOT_RECOVERABLE', `Draft ${draftId} is not pending_recovery`, 409);
    }
    console.error('[bulk-ai/recover] rpc failed', { draftId, code: rpcErr.code });
    return err('RECOVERY_PRODUCT_FAILED', 'Could not create product from draft', 500);
  }

  const row = rpcData?.[0];
  if (!row) {
    console.error('[bulk-ai/recover] rpc returned no row', { draftId });
    return err('RECOVERY_PRODUCT_FAILED', 'Recovery returned no result', 500);
  }

  // Server-side data-safety error: the draft is 'recovered' but its product is
  // missing. Not a client conflict → fixed 500, no DB details leaked.
  if (row.already_recovered && row.product_id == null) {
    console.error('[bulk-ai/recover] inconsistent recovered draft', { draftId, masterSku: row.master_sku });
    return err('RECOVERY_INCONSISTENT', 'Recovered draft is inconsistent', 500);
  }

  if (row.already_recovered) {
    return ok({ ok: true, alreadyRecovered: true, masterSku: row.master_sku, productId: row.product_id });
  }

  return ok({
    ok: true,
    alreadyRecovered: false,
    masterSku: row.master_sku,
    productId: row.product_id,
    resolved,
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  if (raw == null || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.floor(n), min), max);
}
