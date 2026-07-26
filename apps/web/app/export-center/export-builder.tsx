'use client';

/**
 * ExportBuilder — main client UI for /export-center.
 *
 * Layout:
 *   • Left (2/3):  target picker → filters → Preview → eligibility summary → blocked list
 *   • Right (1/3): recent export history
 *
 * Flow:
 *   1. Pick target marketplace
 *   2. Pick filters (or pre-loaded from ?skus=)
 *   3. Click "Run preview" → calls /api/export/preview
 *   4. Inspect results (eligible/blocked)
 *   5. Click "Download CSV" or "Download XLSX" → calls /api/export/generate
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Input, Select, Label } from '@/components/ui';

type Ref = { id: number; name: string };
type Target = 'snoonu' | 'talabat' | 'rafeeq' | 'shopify';

type PreviewResponse = {
  target: Target;
  total: number;
  eligible_count: number;
  blocked_count: number;
  blocked: Array<{
    master_sku: string;
    product_name_en: string | null;
    product_name_ar: string | null;
    reasons: Array<{ field: string; header: string; message: string }>;
  }>;
  sample: Array<{
    master_sku: string;
    product_name_en: string | null;
    product_name_ar: string | null;
    brand?: string;
    category?: string;
    price: number | null;
    image_url: string | null;
  }>;
};

type HistoryItem = {
  id: number;
  target: Target;
  format: 'csv' | 'xlsx';
  product_count: number;
  blocked_count: number;
  file_bytes: number;
  filename: string;
  exported_at: string;
  notes: string | null;
};

const TARGETS: { id: Target; label: string; subtitle: string }[] = [
  { id: 'snoonu', label: 'Snoonu', subtitle: 'Qatar marketplace · bilingual' },
  { id: 'talabat', label: 'Talabat', subtitle: 'Food delivery · barcode required' },
  { id: 'rafeeq', label: 'Rafeeq', subtitle: 'Arabic-first · AR fields strict' },
  { id: 'shopify', label: 'Shopify CSV', subtitle: 'Manual import · use until OAuth wired' },
];

export function ExportBuilder({
  brands,
  categories,
  presetSkus,
  presetTarget,
}: {
  brands: Ref[];
  categories: Ref[];
  presetSkus: string[];
  presetTarget: Target;
}) {
  // ─── State ─────────────────────────────────────────────────────────────
  const [target, setTarget] = useState<Target>(presetTarget);
  const [brandFilter, setBrandFilter] = useState<number | ''>('');
  const [categoryFilter, setCategoryFilter] = useState<number | ''>('');
  const [search, setSearch] = useState('');
  const [useSelection, setUseSelection] = useState(presetSkus.length > 0);
  const [selectionText, setSelectionText] = useState(presetSkus.join('\n'));
  const [notes, setNotes] = useState('');

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [generating, setGenerating] = useState<'csv' | 'xlsx' | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ─── Derived ───────────────────────────────────────────────────────────
  const skuList = useMemo(
    () =>
      selectionText
        .split(/[\n,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean),
    [selectionText],
  );

  const requestBody = useMemo(
    () => ({
      target,
      ...(useSelection && skuList.length > 0 ? { master_skus: skuList } : {}),
      ...(!useSelection
        ? {
            filters: {
              ...(brandFilter ? { brand_id: Number(brandFilter) } : {}),
              ...(categoryFilter ? { category_id: Number(categoryFilter) } : {}),
              ...(search.trim() ? { q: search.trim() } : {}),
            },
          }
        : {}),
    }),
    [target, useSelection, skuList, brandFilter, categoryFilter, search],
  );

  // ─── Preview ───────────────────────────────────────────────────────────
  async function runPreview() {
    setLoadingPreview(true);
    setErrorBanner(null);
    try {
      const res = await fetch('/api/export/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setPreview(body.data);
    } catch (e) {
      setErrorBanner(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoadingPreview(false);
    }
  }

  // ─── Generate file ─────────────────────────────────────────────────────
  async function generate(format: 'csv' | 'xlsx') {
    setGenerating(format);
    setErrorBanner(null);
    try {
      const res = await fetch('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestBody, format, notes: notes || undefined }),
      });
      if (!res.ok) {
        // Try to parse JSON error
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          msg = body?.error?.message ?? msg;
        } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const filename =
        res.headers
          .get('Content-Disposition')
          ?.match(/filename="([^"]+)"/)?.[1] ?? `malikas-${target}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      // Refresh history
      void fetchHistory();
    } catch (e) {
      setErrorBanner(e instanceof Error ? e.message : 'Generate failed');
    } finally {
      setGenerating(null);
    }
  }

  // ─── History ───────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/export/history?limit=20');
      const body = await res.json();
      if (body.ok) setHistory(body.data.items as HistoryItem[]);
    } catch {
      // non-fatal
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  // Re-run preview when target changes (if there was a preview)
  useEffect(() => {
    setPreview(null);
  }, [target, brandFilter, categoryFilter, search, useSelection, skuList.join(',')]);

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
      {/* LEFT — builder */}
      <div className="space-y-4">
        {errorBanner && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive p-3 text-sm flex items-center justify-between">
            <span>⚠ {errorBanner}</span>
            <button onClick={() => setErrorBanner(null)} className="text-xs hover:underline">dismiss</button>
          </div>
        )}

        {/* Target picker */}
        <Card>
          <h2 className="text-lg font-medium mb-3">1. Pick a marketplace</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {TARGETS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTarget(t.id)}
                className={`text-left p-3 rounded-md border transition-colors
                  ${target === t.id
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:bg-muted/50'}
                `}
              >
                <div className="font-medium text-sm">{t.label}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">{t.subtitle}</div>
              </button>
            ))}
          </div>
        </Card>

        {/* Filters / selection */}
        <Card>
          <h2 className="text-lg font-medium mb-3">2. Choose products</h2>
          <div className="flex gap-4 text-sm mb-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={!useSelection}
                onChange={() => setUseSelection(false)}
              />
              <span>Filter all approved products</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={useSelection}
                onChange={() => setUseSelection(true)}
              />
              <span>Specific SKUs ({skuList.length})</span>
            </label>
          </div>

          {!useSelection ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Brand</Label>
                <Select
                  value={String(brandFilter)}
                  onChange={(e) => setBrandFilter(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">All brands</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select
                  value={String(categoryFilter)}
                  onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : '')}
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Search</Label>
                <Input
                  placeholder="Name or SKU…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>SKUs (one per line or comma-separated)</Label>
              <textarea
                rows={4}
                value={selectionText}
                onChange={(e) => setSelectionText(e.target.value)}
                placeholder="MK-SKIN-0001&#10;MK-MAKEUP-0002&#10;MK-BODY-0003"
                className="w-full px-3 py-2 text-sm border border-input bg-background rounded-md font-mono"
              />
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Button onClick={runPreview} disabled={loadingPreview}>
              {loadingPreview ? 'Checking…' : 'Run preview'}
            </Button>
          </div>
        </Card>

        {/* Preview results */}
        {preview && (
          <Card>
            <h2 className="text-lg font-medium mb-3">3. Preview · {TARGETS.find(t => t.id === target)?.label}</h2>

            {/* Summary chips */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Stat label="Total candidates" value={preview.total} />
              <Stat label="Eligible" value={preview.eligible_count} color="text-green-700" />
              <Stat label="Blocked" value={preview.blocked_count} color={preview.blocked_count > 0 ? 'text-destructive' : 'text-muted-foreground'} />
            </div>

            {preview.eligible_count > 0 ? (
              <>
                {/* Eligible sample */}
                <div className="rounded-md border border-border overflow-hidden mb-4">
                  <div className="bg-muted/50 px-3 py-2 text-xs uppercase tracking-wide text-muted-foreground">
                    Sample (first 10 of {preview.eligible_count} eligible)
                  </div>
                  <table className="w-full text-sm">
                    <thead className="border-b border-border bg-muted/30 text-xs">
                      <tr>
                        <th className="text-left px-3 py-1.5">SKU</th>
                        <th className="text-left px-3 py-1.5">Name (EN)</th>
                        <th className="text-left px-3 py-1.5">Brand</th>
                        <th className="text-left px-3 py-1.5">Price</th>
                        <th className="text-left px-3 py-1.5">Image</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {preview.sample.map((p) => (
                        <tr key={p.master_sku}>
                          <td className="px-3 py-1.5 font-mono text-[11px]">{p.master_sku}</td>
                          <td className="px-3 py-1.5 truncate max-w-xs" title={p.product_name_en ?? ''}>
                            {p.product_name_en}
                          </td>
                          <td className="px-3 py-1.5">{p.brand}</td>
                          <td className="px-3 py-1.5">
                            {p.price != null ? `${Number(p.price).toFixed(2)} QAR` : '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            {p.image_url ? '✓' : <span className="text-destructive">✗</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Generate */}
                <div className="rounded-md border border-border p-3 bg-muted/20 space-y-2">
                  <div className="text-sm font-medium">4. Download</div>
                  <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                    <Input
                      placeholder="Notes (optional) — e.g. 'Snoonu launch week 1'"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="flex-1"
                    />
                    <Button onClick={() => generate('csv')} disabled={generating !== null}>
                      {generating === 'csv' ? 'Generating…' : `⬇ CSV (${preview.eligible_count})`}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => generate('xlsx')}
                      disabled={generating !== null}
                    >
                      {generating === 'xlsx' ? 'Generating…' : `⬇ XLSX (${preview.eligible_count})`}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-yellow-300 bg-yellow-50 text-yellow-900 p-3 text-sm">
                ⚠ 0 products pass validation for {target}. Fix blocked items below or change filters.
              </div>
            )}

            {/* Blocked list */}
            {preview.blocked_count > 0 && (
              <details className="mt-4" open={preview.eligible_count === 0}>
                <summary className="cursor-pointer text-sm font-medium text-destructive">
                  ✗ {preview.blocked_count} blocked — click to see reasons
                </summary>
                <div className="mt-2 rounded-md border border-destructive/30 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-destructive/10 text-xs">
                      <tr>
                        <th className="text-left px-3 py-1.5">SKU</th>
                        <th className="text-left px-3 py-1.5">Name (EN)</th>
                        <th className="text-left px-3 py-1.5">Missing required</th>
                        <th className="text-left px-3 py-1.5 w-16">Fix</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {preview.blocked.map((b) => (
                        <tr key={b.master_sku}>
                          <td className="px-3 py-1.5 font-mono text-[11px]">{b.master_sku}</td>
                          <td className="px-3 py-1.5 truncate max-w-xs" title={b.product_name_en ?? ''}>
                            {b.product_name_en ?? <em className="text-muted-foreground">(no name)</em>}
                          </td>
                          <td className="px-3 py-1.5 text-xs">
                            <ul className="space-y-0.5">
                              {b.reasons.map((r) => (
                                <li key={r.field} className="text-destructive">
                                  <span className="font-medium">{r.header}:</span> {r.message}
                                </li>
                              ))}
                            </ul>
                          </td>
                          <td className="px-3 py-1.5">
                            <a
                              href={`/products/${b.master_sku}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline text-xs"
                            >
                              Open →
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </Card>
        )}
      </div>

      {/* RIGHT — history */}
      <div className="space-y-4">
        <Card>
          <h2 className="text-lg font-medium mb-3">Recent exports</h2>
          {historyLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-muted-foreground">No exports yet.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.map((h) => (
                <li key={h.id} className="rounded-md border border-border p-2 space-y-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium capitalize">{h.target}</span>
                    <span className="text-[10px] uppercase tracking-wide bg-muted px-1.5 py-0.5 rounded">
                      {h.format}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {h.product_count} products
                    {h.blocked_count > 0 && (
                      <span className="text-destructive ml-1">· {h.blocked_count} blocked</span>
                    )}
                    {' · '}
                    {fmtBytes(h.file_bytes)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(h.exported_at).toLocaleString()}
                  </div>
                  {h.notes && (
                    <div className="text-[11px] italic text-muted-foreground/80 truncate" title={h.notes}>
                      {h.notes}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold ${color ?? ''}`}>{value}</div>
    </div>
  );
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
