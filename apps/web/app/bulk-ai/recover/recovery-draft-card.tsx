'use client';

/**
 * RecoveryDraftCard — one saved AI draft + an inline recovery editor.
 *
 * Presentational + local form state only. All network work (the POST) is done
 * by the parent dashboard via `onRecover`; this card just collects overrides,
 * validates the two required names, and reflects the per-draft busy / error /
 * success state passed down to it.
 */

import { useMemo, useState } from 'react';
import { Button, Input, Textarea, Select, Label, Card, Badge } from '@/components/ui';
import {
  type RecoveryDraft,
  type RefRow,
  type SubcategoryRow,
  type RecoveryFormState,
  type FormErrors,
  initialFormState,
  validateForm,
  buildOverrides,
  subcategoriesForCategory,
  clearIncompatibleSubcategory,
  summarizeFailingPayload,
  confidenceLabel,
  productHref,
  type RecoveryOverrides,
} from './recovery-logic';

export interface RecoverResult {
  masterSku: string | null;
  alreadyRecovered: boolean;
}

export function RecoveryDraftCard({
  draft,
  brands,
  categories,
  subcategories,
  busy,
  error,
  onRecover,
}: {
  draft: RecoveryDraft;
  brands: RefRow[];
  categories: RefRow[];
  subcategories: SubcategoryRow[];
  busy: boolean;
  error: string | null;
  onRecover: (draftId: number, overrides: RecoveryOverrides) => void;
}) {
  const [form, setForm] = useState<RecoveryFormState>(() => initialFormState(draft.suggestion));
  const [errors, setErrors] = useState<FormErrors>({});

  const subOptions = useMemo(
    () => subcategoriesForCategory(subcategories, form.categoryId),
    [subcategories, form.categoryId],
  );

  const set = <K extends keyof RecoveryFormState>(key: K, value: RecoveryFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const onCategoryChange = (value: number | '') =>
    setForm((f) => clearIncompatibleSubcategory({ ...f, categoryId: value }, subcategories));

  const submit = () => {
    if (busy) return; // guard also enforced in the parent by draftId
    const { ok, errors: e } = validateForm(form);
    setErrors(e);
    if (!ok) return;
    onRecover(draft.id, buildOverrides(form, subcategories));
  };

  const conf = confidenceLabel(draft.confidence);
  const payloadKeys = summarizeFailingPayload(draft.failing_payload);
  const fieldId = (name: string) => `d${draft.id}-${name}`;

  return (
    <Card className="!p-4 space-y-4">
      {/* ── Header: image + meta ───────────────────────────────────────────── */}
      <div className="flex gap-4">
        <div className="w-24 h-24 shrink-0 rounded-md overflow-hidden bg-muted border border-border">
          {draft.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={draft.image_url}
              alt={form.productNameEn || draft.original_filename || `Draft ${draft.id}`}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
              no image
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate max-w-full break-words">
              {draft.original_filename || `Draft #${draft.id}`}
            </span>
            {conf && <Badge variant="muted">confidence {conf}</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            Saved {new Date(draft.created_at).toLocaleString()}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {draft.suggestion?.brand_hint && <span>brand hint: {draft.suggestion.brand_hint}</span>}
            {draft.suggestion?.category_hint && <span>category hint: {draft.suggestion.category_hint}</span>}
            {draft.suggestion?.subcategory_hint && <span>subcat hint: {draft.suggestion.subcategory_hint}</span>}
          </div>
        </div>
      </div>

      {/* ── Failure reason (not colour-only: icon + heading + text) ─────────── */}
      <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm">
        <p className="font-medium text-yellow-800 dark:text-yellow-300">
          <span aria-hidden="true">⚠ </span>Why product creation failed
        </p>
        <ul className="mt-1 space-y-0.5 text-xs text-yellow-900/90 dark:text-yellow-200/90">
          {draft.error_code && (
            <li>
              <span className="font-medium">Code:</span> {draft.error_code}
            </li>
          )}
          {draft.error_message && (
            <li className="break-words">
              <span className="font-medium">Detail:</span> {draft.error_message}
            </li>
          )}
          {draft.failing_table && (
            <li>
              <span className="font-medium">Table:</span> {draft.failing_table}
            </li>
          )}
          {payloadKeys && (
            <li className="break-words">
              <span className="font-medium">Rejected fields:</span> {payloadKeys}
            </li>
          )}
        </ul>
      </div>

      {/* ── Editable fields ────────────────────────────────────────────────── */}
      <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
        <legend className="sr-only">Recovery fields for draft {draft.id}</legend>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={fieldId('name-en')} required>Product name (EN)</Label>
            <Input
              id={fieldId('name-en')}
              dir="ltr"
              value={form.productNameEn}
              aria-invalid={!!errors.productNameEn}
              onChange={(e) => set('productNameEn', e.target.value)}
            />
            {errors.productNameEn && (
              <p className="text-xs text-destructive">{errors.productNameEn}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId('name-ar')} required>Product name (AR)</Label>
            <Input
              id={fieldId('name-ar')}
              dir="rtl"
              value={form.productNameAr}
              aria-invalid={!!errors.productNameAr}
              onChange={(e) => set('productNameAr', e.target.value)}
            />
            {errors.productNameAr && (
              <p className="text-xs text-destructive">{errors.productNameAr}</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={fieldId('desc-en')}>Description (EN)</Label>
            <Textarea
              id={fieldId('desc-en')}
              dir="ltr"
              className="!min-h-[80px]"
              value={form.descriptionEn}
              onChange={(e) => set('descriptionEn', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId('desc-ar')}>Description (AR)</Label>
            <Textarea
              id={fieldId('desc-ar')}
              dir="rtl"
              className="!min-h-[80px]"
              value={form.descriptionAr}
              onChange={(e) => set('descriptionAr', e.target.value)}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={fieldId('usage-en')}>Usage (EN)</Label>
            <Textarea
              id={fieldId('usage-en')}
              dir="ltr"
              className="!min-h-[80px]"
              value={form.usageEn}
              onChange={(e) => set('usageEn', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId('usage-ar')}>Usage (AR)</Label>
            <Textarea
              id={fieldId('usage-ar')}
              dir="rtl"
              className="!min-h-[80px]"
              value={form.usageAr}
              onChange={(e) => set('usageAr', e.target.value)}
            />
          </div>
        </div>

        {/* Brand: pick existing OR type a new name (existing wins on submit) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={fieldId('brand')}>Brand (existing)</Label>
            <Select
              id={fieldId('brand')}
              value={String(form.brandId)}
              onChange={(e) => set('brandId', e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">— use AI hint / new name —</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId('brand-name')}>Or new brand name</Label>
            <Input
              id={fieldId('brand-name')}
              value={form.brandName}
              placeholder={form.brandId ? 'ignored (existing brand selected)' : 'Create a new brand'}
              disabled={busy || !!form.brandId}
              onChange={(e) => set('brandName', e.target.value)}
            />
          </div>
        </div>

        {/* Category + dependent subcategory */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor={fieldId('category')}>Category</Label>
            <Select
              id={fieldId('category')}
              value={String(form.categoryId)}
              onChange={(e) => onCategoryChange(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">— use AI hint —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={fieldId('subcategory')}>Subcategory</Label>
            <Select
              id={fieldId('subcategory')}
              value={String(form.subcategoryId)}
              disabled={busy || !form.categoryId}
              onChange={(e) => set('subcategoryId', e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">{form.categoryId ? '— none —' : 'Pick a category first'}</option>
              {subOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </fieldset>

      {/* ── Per-draft error (server/field/network) ─────────────────────────── */}
      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive p-2 text-xs">
          <span aria-hidden="true">⚠ </span>{error}
        </div>
      )}

      {/* ── Actions ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Recovered products are created as <strong>drafts</strong> (price/stock stay at defaults).
        </p>
        <Button type="button" onClick={submit} disabled={busy}>
          {busy ? 'Recovering…' : 'Recover Product'}
        </Button>
      </div>
    </Card>
  );
}

/** Small helper used by the dashboard toast to link to a recovered product. */
export function productLink(masterSku: string) {
  return productHref(masterSku);
}
