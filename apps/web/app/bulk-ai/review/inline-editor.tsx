'use client';

/**
 * InlineEditor — slide-in side panel for editing a single AI draft.
 *
 * Layout (desktop): two columns
 *   • Left:  AI suggestion (read-only) — what Claude produced from the image
 *   • Right: Final product fields (editable) — what will be saved
 *
 * Fields editable here:
 *   • product_name_en / product_name_ar
 *   • brand_id (dropdown)
 *   • category_id (dropdown)
 *   • description_en / description_ar
 *   • usage_en / usage_ar
 *   • keywords_en / keywords_ar (comma-separated)
 *   • price + stock_quantity (must be set before Marketplace Ready)
 *
 * Save uses PATCH /api/products/[sku] (existing endpoint).
 *
 * Push to Shopify is a stub — disabled until /api/shopify/push exists.
 */

import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Textarea, Select, Label } from '@/components/ui';
import { checkReadiness, type ProductForReadiness } from '@/lib/readiness';
import { ReadinessBar, ReadinessIssuesList } from '@/components/readiness-badge';

type Ref = { id: number; name: string; code?: string | null };

type FullDraft = {
  master_sku: string;
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
  discount_price: number | null;
  stock_quantity: number;
  stock_status: string;
  product_status: string;
  description_en: string | null;
  description_ar: string | null;
  usage_en: string | null;
  usage_ar: string | null;
  keywords_en: string[] | null;
  keywords_ar: string[] | null;
  image_url: string | null;
  ai_confidence: number | null;
  ai_meta: Record<string, unknown> | null;
  brand: { id: number; name: string } | null;
  category: { id: number; name: string } | null;
};

export function InlineEditor({
  masterSku,
  brands,
  categories,
  onClose,
  onSaved,
}: {
  masterSku: string;
  brands: Ref[];
  categories: Ref[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<FullDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Editable fields
  const [name_en, setNameEn] = useState('');
  const [name_ar, setNameAr] = useState('');
  const [brand_id, setBrandId] = useState<number | ''>('');
  const [category_id, setCategoryId] = useState<number | ''>('');
  const [desc_en, setDescEn] = useState('');
  const [desc_ar, setDescAr] = useState('');
  const [usage_en, setUsageEn] = useState('');
  const [usage_ar, setUsageAr] = useState('');
  const [keywords_en, setKeywordsEn] = useState('');
  const [keywords_ar, setKeywordsAr] = useState('');
  const [price, setPrice] = useState<string>('');
  const [stock_quantity, setStockQuantity] = useState<string>('');

  // ─── Load draft ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/products/${masterSku}`);
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (cancel) return;
        const d: FullDraft = body.data;
        setDraft(d);
        setNameEn(d.product_name_en ?? '');
        setNameAr(d.product_name_ar ?? '');
        setBrandId(d.brand_id ?? '');
        setCategoryId(d.category_id ?? '');
        setDescEn(d.description_en ?? '');
        setDescAr(d.description_ar ?? '');
        setUsageEn(d.usage_en ?? '');
        setUsageAr(d.usage_ar ?? '');
        setKeywordsEn((d.keywords_en ?? []).join(', '));
        setKeywordsAr((d.keywords_ar ?? []).join('، '));
        setPrice(String(d.price ?? 0));
        setStockQuantity(String(d.stock_quantity ?? 0));
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : 'Failed to load draft');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [masterSku]);

  // ─── AI suggestion (raw) ──────────────────────────────────────────────────
  const aiSuggestion = useMemo(() => {
    if (!draft?.ai_meta) return null;
    const meta = draft.ai_meta as Record<string, unknown>;
    return {
      brand_hint: meta.brand_hint as string | null,
      category_hint: meta.category_hint as string | null,
      subcategory_hint: meta.subcategory_hint as string | null,
      reasoning: meta.reasoning as string | null,
      cost_usd: meta.cost_usd as number | null,
      model: meta.model as string | null,
      fallback_used: meta.fallback_used as boolean | null,
    };
  }, [draft]);

  // ─── Save ─────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = {
        product_name_en: name_en.trim(),
        product_name_ar: name_ar.trim(),
        description_en: desc_en.trim() || null,
        description_ar: desc_ar.trim() || null,
        usage_en: usage_en.trim() || null,
        usage_ar: usage_ar.trim() || null,
        keywords_en: parseKeywords(keywords_en),
        keywords_ar: parseKeywords(keywords_ar),
        price: Number(price) || 0,
        stock_quantity: Number(stock_quantity) || 0,
      };
      // Only include FK ids if a real value is set — schema requires positive int
      const brandIdNum = typeof brand_id === 'number' ? brand_id : Number(brand_id);
      if (Number.isFinite(brandIdNum) && brandIdNum > 0) payload.brand_id = brandIdNum;
      const categoryIdNum = typeof category_id === 'number' ? category_id : Number(category_id);
      if (Number.isFinite(categoryIdNum) && categoryIdNum > 0) payload.category_id = categoryIdNum;

      const res = await fetch(`/api/products/${masterSku}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);

      setSuccess('Saved');
      setTimeout(async () => {
        await onSaved();
      }, 400);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    setSaving(true);
    setError(null);
    try {
      // Save edits first
      await handleSave();
      // Then approve
      const res = await fetch('/api/bulk-ai/drafts/bulk-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', master_skus: [masterSku] }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      if (body.data.failed?.length > 0) throw new Error(body.data.failed[0].error);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setSaving(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/40 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />

      {/* Panel */}
      <div className="w-full max-w-4xl bg-background border-l border-border shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background border-b border-border p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground font-mono">{masterSku}</div>
            <div className="text-lg font-semibold">Edit AI draft</div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
              Close (Esc)
            </Button>
            <Button variant="secondary" size="sm" onClick={handleSave} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" onClick={handleApprove} disabled={saving || loading}>
              ✓ Save & Approve
            </Button>
          </div>
        </div>

        {error && (
          <div className="m-4 rounded-lg border border-destructive/40 bg-destructive/10 text-destructive p-3 text-sm">
            ⚠ {error}
          </div>
        )}
        {success && (
          <div className="m-4 rounded-lg border border-green-300 bg-green-50 text-green-800 p-3 text-sm">
            ✓ {success}
          </div>
        )}

        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading draft…</div>
        ) : !draft ? (
          <div className="p-8 text-center text-destructive">Could not load draft.</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 p-4">
            {/* Left: AI suggestion (read-only) + image */}
            <div className="space-y-3">
              {draft.image_url && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={draft.image_url} alt="" className="w-full aspect-square object-cover rounded-lg border border-border" />
              )}

              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                <div className="text-xs uppercase font-semibold text-muted-foreground tracking-wide">
                  AI suggestion (read-only)
                </div>

                {aiSuggestion?.brand_hint && (
                  <KV k="Brand hint" v={aiSuggestion.brand_hint} />
                )}
                {aiSuggestion?.category_hint && (
                  <KV k="Category hint" v={aiSuggestion.category_hint} />
                )}
                {aiSuggestion?.subcategory_hint && (
                  <KV k="Subcategory hint" v={aiSuggestion.subcategory_hint} />
                )}
                <KV
                  k="Confidence"
                  v={
                    draft.ai_confidence != null
                      ? `${Math.round(draft.ai_confidence * 100)}%`
                      : '—'
                  }
                />
                <KV k="Model" v={aiSuggestion?.model ?? '—'} />
                <KV
                  k="AI cost"
                  v={
                    aiSuggestion?.cost_usd != null
                      ? `$${Number(aiSuggestion.cost_usd).toFixed(4)}`
                      : '—'
                  }
                />
                {aiSuggestion?.fallback_used && (
                  <div className="text-[11px] text-yellow-700">⚠ AR fallback was used</div>
                )}

                {aiSuggestion?.reasoning && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Why Claude picked this
                    </summary>
                    <div className="mt-1 text-foreground/80 leading-relaxed">
                      {aiSuggestion.reasoning}
                    </div>
                  </details>
                )}
              </div>

              {/* Live readiness for current edits (live recalc as user types) */}
              <LivePushPanel
                liveProduct={{
                  ...(draft as ProductForReadiness),
                  product_name_en: name_en,
                  product_name_ar: name_ar,
                  description_en: desc_en,
                  description_ar: desc_ar,
                  usage_en,
                  usage_ar,
                  keywords_en: parseKeywords(keywords_en),
                  keywords_ar: parseKeywords(keywords_ar),
                  brand_id: typeof brand_id === 'number' ? brand_id : Number(brand_id) || null,
                  category_id: typeof category_id === 'number' ? category_id : Number(category_id) || null,
                  price: Number(price) || 0,
                  stock_quantity: Number(stock_quantity) || 0,
                }}
                masterSku={draft.master_sku}
                productStatus={draft.product_status}
                shopifyInfo={{
                  product_id: (draft as Record<string, unknown>).shopify_product_id as number | null,
                  handle: (draft as Record<string, unknown>).shopify_handle as string | null,
                  synced_at: (draft as Record<string, unknown>).shopify_synced_at as string | null,
                }}
                onPushSucceeded={onSaved}
              />
            </div>

            {/* Right: editable fields */}
            <div className="space-y-4">
              {/* Names */}
              <Field label="Name (EN)" required>
                <Input value={name_en} onChange={(e) => setNameEn(e.target.value)} />
              </Field>

              <Field label="Name (AR)" required>
                <Input
                  value={name_ar}
                  onChange={(e) => setNameAr(e.target.value)}
                  dir="rtl"
                  className="font-arabic"
                />
              </Field>

              {/* Brand + category row */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand">
                  <Select
                    value={String(brand_id)}
                    onChange={(e) => setBrandId(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">— select —</option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Category">
                  <Select
                    value={String(category_id)}
                    onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">— select —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              {/* Price + stock (required for marketplace ready) */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Price (QAR)" hint="Required for marketplace publish">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                </Field>
                <Field label="Stock quantity">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={stock_quantity}
                    onChange={(e) => setStockQuantity(e.target.value)}
                  />
                </Field>
              </div>

              {/* Descriptions */}
              <Field label="Description (EN)">
                <Textarea
                  rows={6}
                  value={desc_en}
                  onChange={(e) => setDescEn(e.target.value)}
                />
              </Field>

              <Field label="Description (AR)">
                <Textarea
                  rows={6}
                  value={desc_ar}
                  onChange={(e) => setDescAr(e.target.value)}
                  dir="rtl"
                  className="font-arabic"
                />
              </Field>

              {/* Usage */}
              <Field label="Usage steps (EN)">
                <Textarea
                  rows={3}
                  value={usage_en}
                  onChange={(e) => setUsageEn(e.target.value)}
                />
              </Field>

              <Field label="Usage steps (AR)">
                <Textarea
                  rows={3}
                  value={usage_ar}
                  onChange={(e) => setUsageAr(e.target.value)}
                  dir="rtl"
                  className="font-arabic"
                />
              </Field>

              {/* Keywords */}
              <Field label="Keywords (EN)" hint="Comma-separated">
                <Input value={keywords_en} onChange={(e) => setKeywordsEn(e.target.value)} />
              </Field>
              <Field label="Keywords (AR)" hint="مفصولة بفاصلة عربية «،»">
                <Input
                  value={keywords_ar}
                  onChange={(e) => setKeywordsAr(e.target.value)}
                  dir="rtl"
                  className="font-arabic"
                />
              </Field>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label required={required}>{label}</Label>
      {children}
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="text-xs flex items-baseline gap-2">
      <span className="text-muted-foreground w-24 flex-shrink-0">{k}</span>
      <span className="font-medium break-words">{v}</span>
    </div>
  );
}

function parseKeywords(s: string): string[] | null {
  // Split on comma (Latin), Arabic comma, or pipe
  const parts = s
    .split(/[,،|]/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : null;
}

// ─── Live push panel — recomputes readiness on every keystroke ──────────────

function LivePushPanel({
  liveProduct,
  masterSku,
  productStatus,
  shopifyInfo,
  onPushSucceeded,
}: {
  liveProduct: ProductForReadiness;
  masterSku: string;
  productStatus: string;
  shopifyInfo: { product_id: number | null; handle: string | null; synced_at: string | null };
  onPushSucceeded: () => Promise<void> | void;
}) {
  const readiness = useMemo(() => checkReadiness(liveProduct, 'shopify'), [liveProduct]);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<
    | { ok: true; admin_url: string; storefront_url: string; action: 'created' | 'updated' }
    | { ok: false; message: string }
    | null
  >(null);

  const canPush = readiness.ready && productStatus === 'active' && !pushing;
  const blocker =
    productStatus !== 'active'
      ? `Product must be Active (currently "${productStatus}"). Save & Approve first.`
      : !readiness.ready
        ? `Readiness ${readiness.score}% — need ≥ 90% with no errors.`
        : null;

  async function handlePush() {
    setPushing(true);
    setPushResult(null);
    try {
      const res = await fetch('/api/shopify/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: masterSku }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setPushResult({
        ok: true,
        admin_url: body.data.admin_url,
        storefront_url: body.data.storefront_url,
        action: body.data.action,
      });
      await onPushSucceeded();
    } catch (e) {
      setPushResult({ ok: false, message: e instanceof Error ? e.message : 'Push failed' });
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      <div className="text-xs uppercase font-semibold text-muted-foreground tracking-wide">
        Marketplace publish
      </div>

      <ReadinessBar
        score={readiness.score}
        ready={readiness.ready}
        target="shopify"
        error_count={readiness.error_count}
        warning_count={readiness.warning_count}
      />

      {/* Existing sync info */}
      {shopifyInfo.product_id && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <div>
            Synced to Shopify ID <span className="font-mono">{shopifyInfo.product_id}</span>
          </div>
          {shopifyInfo.synced_at && (
            <div>Last synced: {new Date(shopifyInfo.synced_at).toLocaleString()}</div>
          )}
        </div>
      )}

      {/* Push button + state */}
      <Button
        size="sm"
        className="w-full"
        onClick={handlePush}
        disabled={!canPush}
        title={blocker ?? 'Push to Shopify'}
      >
        {pushing
          ? 'Pushing…'
          : shopifyInfo.product_id
            ? '↻ Re-sync to Shopify'
            : '↑ Push to Shopify'}
      </Button>

      {blocker && (
        <div className="text-[11px] text-muted-foreground leading-tight">{blocker}</div>
      )}

      {/* Push outcome */}
      {pushResult?.ok && (
        <div className="rounded-md border border-green-300 bg-green-50 p-2.5 text-sm text-green-900">
          <div className="font-medium">✓ {pushResult.action === 'created' ? 'Created' : 'Updated'} on Shopify</div>
          <div className="mt-1 flex flex-col gap-1">
            <a
              href={pushResult.admin_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              View in Shopify Admin →
            </a>
            <a
              href={pushResult.storefront_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              View on storefront →
            </a>
          </div>
        </div>
      )}
      {pushResult && !pushResult.ok && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive">
          ✗ {pushResult.message}
        </div>
      )}

      {/* Compact issues list */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Readiness details ({readiness.issues.length})
        </summary>
        <div className="mt-2">
          <ReadinessIssuesList issues={readiness.issues} />
        </div>
      </details>
    </div>
  );
}
