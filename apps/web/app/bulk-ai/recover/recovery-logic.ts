/**
 * Pure, framework-free logic for the Bulk-AI Recovery UI.
 *
 * Kept separate from the React component so it can be unit-tested under Vitest's
 * default node environment (no DOM / testing-library needed). The dashboard
 * imports these helpers; nothing here touches the network, Supabase or the DOM.
 */

// ─── Shapes coming back from GET /api/bulk-ai/recover ─────────────────────────

export interface DraftSuggestion {
  product_name_en?: string | null;
  product_name_ar?: string | null;
  description_en?: string | null;
  description_ar?: string | null;
  usage_en?: string | null;
  usage_ar?: string | null;
  brand_hint?: string | null;
  category_hint?: string | null;
  subcategory_hint?: string | null;
  [k: string]: unknown;
}

export interface RecoveryDraft {
  id: number;
  image_url: string;
  original_filename: string | null;
  suggestion: DraftSuggestion | null;
  confidence: number | null;
  ai_meta: unknown;
  error_code: string | null;
  error_message: string | null;
  failing_table: string | null;
  failing_payload: unknown;
  created_at: string;
}

export interface RefRow {
  id: number;
  name: string;
  code?: string | null;
}
export interface SubcategoryRow {
  id: number;
  name: string;
  category_id: number;
}

// ─── Editable form state ──────────────────────────────────────────────────────

export interface RecoveryFormState {
  productNameEn: string;
  productNameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  usageEn: string;
  usageAr: string;
  brandId: number | '';
  brandName: string;
  categoryId: number | '';
  subcategoryId: number | '';
}

/** Overrides sent to POST /api/bulk-ai/recover (only present, valid keys). */
export interface RecoveryOverrides {
  brandId?: number;
  brandName?: string;
  categoryId?: number;
  subcategoryId?: number;
  productNameEn?: string;
  productNameAr?: string;
  descriptionEn?: string;
  descriptionAr?: string;
  usageEn?: string;
  usageAr?: string;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Coerce any stored value to a string form field ('' for null/undefined). */
export function toFormValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  return String(v);
}

/**
 * Seed the editable form from the stored AI suggestion. Text fields start from
 * the suggestion; brand/category/subcategory selections start empty (the backend
 * resolves the AI hints when no override is supplied).
 */
export function initialFormState(s: DraftSuggestion | null | undefined): RecoveryFormState {
  return {
    productNameEn: toFormValue(s?.product_name_en),
    productNameAr: toFormValue(s?.product_name_ar),
    descriptionEn: toFormValue(s?.description_en),
    descriptionAr: toFormValue(s?.description_ar),
    usageEn: toFormValue(s?.usage_en),
    usageAr: toFormValue(s?.usage_ar),
    brandId: '',
    brandName: '',
    categoryId: '',
    subcategoryId: '',
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface FormErrors {
  productNameEn?: string;
  productNameAr?: string;
}

/** English and Arabic product names are required; nothing else blocks submit. */
export function validateForm(form: RecoveryFormState): { ok: boolean; errors: FormErrors } {
  const errors: FormErrors = {};
  if (!form.productNameEn.trim()) errors.productNameEn = 'English product name is required';
  if (!form.productNameAr.trim()) errors.productNameAr = 'Arabic product name is required';
  return { ok: Object.keys(errors).length === 0, errors };
}

// ─── Overrides payload ────────────────────────────────────────────────────────

/**
 * Build the `overrides` object for the POST body:
 *   • only non-empty text fields are included,
 *   • an existing brand selection (brandId) wins over a typed brandName —
 *     never both are sent,
 *   • category/subcategory are sent as numbers,
 *   • a subcategory incompatible with the chosen category is dropped (when the
 *     subcategory reference list is provided to check membership).
 */
export function buildOverrides(form: RecoveryFormState, subcategories?: SubcategoryRow[]): RecoveryOverrides {
  const o: RecoveryOverrides = {};
  const t = (v: string) => v.trim();

  if (t(form.productNameEn)) o.productNameEn = t(form.productNameEn);
  if (t(form.productNameAr)) o.productNameAr = t(form.productNameAr);
  if (t(form.descriptionEn)) o.descriptionEn = t(form.descriptionEn);
  if (t(form.descriptionAr)) o.descriptionAr = t(form.descriptionAr);
  if (t(form.usageEn)) o.usageEn = t(form.usageEn);
  if (t(form.usageAr)) o.usageAr = t(form.usageAr);

  // Brand: existing selection wins; else a typed new name. Never both.
  if (isPositiveInt(form.brandId)) {
    o.brandId = form.brandId;
  } else if (t(form.brandName)) {
    o.brandName = t(form.brandName);
  }

  const categoryId = isPositiveInt(form.categoryId) ? form.categoryId : undefined;
  if (categoryId != null) o.categoryId = categoryId;

  if (isPositiveInt(form.subcategoryId)) {
    const subId = form.subcategoryId;
    let compatible = true;
    if (subcategories) {
      const sub = subcategories.find((s) => s.id === subId);
      compatible = !!sub && (categoryId == null || sub.category_id === categoryId);
    }
    if (compatible) o.subcategoryId = subId;
  }

  return o;
}

// ─── Category → subcategory helpers ───────────────────────────────────────────

/** Subcategories belonging to the chosen category (empty when no category). */
export function subcategoriesForCategory(
  subcategories: SubcategoryRow[],
  categoryId: number | '',
): SubcategoryRow[] {
  if (!isPositiveInt(categoryId)) return [];
  return subcategories.filter((s) => s.category_id === categoryId);
}

/** After a category change, clear a subcategory that no longer belongs to it. */
export function clearIncompatibleSubcategory(
  form: RecoveryFormState,
  subcategories: SubcategoryRow[],
): RecoveryFormState {
  if (!isPositiveInt(form.subcategoryId)) return form;
  const sub = subcategories.find((s) => s.id === form.subcategoryId);
  const ok = !!sub && (!isPositiveInt(form.categoryId) || sub.category_id === form.categoryId);
  return ok ? form : { ...form, subcategoryId: '' };
}

// ─── Success reducer (list + total) ───────────────────────────────────────────

export interface ListState<T extends { id: number }> {
  items: T[];
  total: number;
}

/**
 * Remove a recovered draft from the list and decrement the total EXACTLY once.
 * Idempotent: a repeated success for an already-removed draft leaves the state
 * unchanged (never double-decrements, never goes negative).
 */
export function applyRecoverySuccess<T extends { id: number }>(
  state: ListState<T>,
  draftId: number,
): ListState<T> {
  const exists = state.items.some((i) => i.id === draftId);
  if (!exists) return state;
  return {
    items: state.items.filter((i) => i.id !== draftId),
    total: Math.max(0, state.total - 1),
  };
}

// ─── Per-draft busy guard (prevents double-submit) ────────────────────────────

export function canSubmit(busy: ReadonlySet<number>, draftId: number): boolean {
  return !busy.has(draftId);
}
export function markBusy(busy: ReadonlySet<number>, draftId: number): Set<number> {
  const next = new Set(busy);
  next.add(draftId);
  return next;
}
export function releaseBusy(busy: ReadonlySet<number>, draftId: number): Set<number> {
  const next = new Set(busy);
  next.delete(draftId);
  return next;
}

// ─── Error normalization (never surfaces raw DB text) ─────────────────────────

const KNOWN_ERROR_MESSAGES: Record<string, string> = {
  BAD_REQUEST: 'The request was invalid. Check the fields and try again.',
  DRAFT_NOT_FOUND: 'This draft no longer exists — refresh the queue.',
  DRAFT_NOT_RECOVERABLE: 'This draft can no longer be recovered (it was already handled).',
  INVALID_SUGGESTION: 'The saved AI suggestion is invalid and cannot become a product.',
  BAD_BRAND: 'The selected brand was not found — pick a different brand.',
  BAD_CATEGORY: 'The selected category was not found — pick a different category.',
  BAD_SUBCATEGORY: 'The selected subcategory is not valid for this category.',
  RECOVERY_INCONSISTENT:
    'Server data inconsistency: this draft is marked recovered but its product is missing. Needs admin review.',
  RECOVERY_PRODUCT_FAILED: 'Could not create the product from this draft. Please try again.',
};

export const NETWORK_ERROR_MESSAGE = 'Network error — check your connection and try again.';
export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Map an API error code (or a network failure) to a user-facing message. Only
 * the code is consulted — a raw database/error message is never passed through.
 */
export function recoveryErrorMessage(code?: string, opts?: { isNetwork?: boolean }): string {
  if (opts?.isNetwork) return NETWORK_ERROR_MESSAGE;
  if (code && Object.prototype.hasOwnProperty.call(KNOWN_ERROR_MESSAGES, code)) {
    return KNOWN_ERROR_MESSAGES[code]!;
  }
  return GENERIC_ERROR_MESSAGE;
}

/** Codes that indicate a server-side fault rather than a bad field value. */
export function isServerSideError(code?: string): boolean {
  return code === 'RECOVERY_INCONSISTENT' || code === 'RECOVERY_PRODUCT_FAILED';
}

// ─── Misc display helpers ─────────────────────────────────────────────────────

/** Compact key summary of a failing payload (no huge JSON in the UI). */
export function summarizeFailingPayload(payload: unknown, maxKeys = 6): string {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const keys = Object.keys(payload as Record<string, unknown>);
  if (keys.length === 0) return '';
  const shown = keys.slice(0, maxKeys);
  const more = keys.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` +${more} more` : '');
}

/** Product page link for a recovered product. */
export function productHref(masterSku: string): string {
  return `/products/${masterSku}`;
}

/** Confidence as a percentage label, or null when unknown. */
export function confidenceLabel(confidence: number | null | undefined): string | null {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  return `${Math.round(confidence * 100)}%`;
}
