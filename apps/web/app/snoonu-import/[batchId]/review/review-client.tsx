/**
 * Review screen client — polls /status, lists items with action buttons.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │ Progress bar + status pill + filters                         │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Bulk actions row (visible when items are selected)           │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Items table — checkbox / image / name / SKU / match / action │
 *   │   • Click row → drawer with full extracted detail + edit     │
 *   ├─────────────────────────────────────────────────────────────┤
 *   │ Apply bar (sticky bottom) — count of approved + Apply button │
 *   └─────────────────────────────────────────────────────────────┘
 */
'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Badge } from '@/components/ui';

type Batch = {
  id: number;
  label: string | null;
  status: string;
  total_items: number;
  extracted_count: number;
  matched_count: number;
  variant_count: number;
  applied_count: number;
  blocked_count: number;
  image_failed_count: number;
};

type Item = {
  id: number;
  source_url: string;
  source_image_url: string | null;
  extracted_name_en: string | null;
  extracted_name_ar: string | null;
  extracted_brand: string | null;
  extracted_price: number | null;
  extracted_discount_price: number | null;
  extracted_sku: string | null;
  extracted_barcode: string | null;
  extracted_description_en: string | null;
  extracted_description_ar: string | null;
  generated_sku: string | null;
  imported_image_url: string | null;
  image_status: string;
  image_quality_issues: string[];
  match_status: string;
  matched_product_sku: string | null;
  match_confidence: number | null;
  match_reasons: string[];
  review_action: string | null;
  ai_enriched: boolean;
  ai_filled_fields: string[];
  status: string;
  raw_payload: {
    variants?: Array<{ variant_value: string; variant_type: string; variant_code: string }>;
    variant_count?: number;
    enriched?: {
      name_en: string;
      name_ar: string;
      description_en: string;
      description_ar: string;
      keywords_en: string[];
      keywords_ar: string[];
      confidence: number;
    };
    image_quality_report?: {
      score: number;
      issues: string[];
      notes: string | null;
    };
  } | null;
  error_message: string | null;
};

type StatusPayload = {
  batch: Batch;
  items_total: number;
  counts: Record<string, number>;
  match_summary: Record<string, number>;
};

const MATCH_PILL: Record<string, { label: string; tone: 'success' | 'warning' | 'info' | 'neutral' }> = {
  exact: { label: 'Exact match', tone: 'warning' },
  likely: { label: 'Likely match', tone: 'warning' },
  possible: { label: 'Possible match', tone: 'info' },
  none: { label: 'New product', tone: 'success' },
  pending: { label: 'Pending', tone: 'neutral' },
};

const TONE_CLS: Record<'success' | 'warning' | 'info' | 'neutral', string> = {
  success: 'bg-green-100 text-green-800 border-green-200',
  warning: 'bg-amber-100 text-amber-800 border-amber-200',
  info: 'bg-blue-100 text-blue-800 border-blue-200',
  neutral: 'bg-gray-100 text-gray-700 border-gray-200',
};

const ACTION_BADGE: Record<string, string> = {
  create_new: 'Create new',
  update_existing: 'Update existing',
  link_variant: 'Link as variant',
  skip: 'Skip',
  needs_manual: 'Needs manual',
};

export default function ReviewClient({
  batchId,
  initialBatch,
}: {
  batchId: number;
  initialBatch: Batch;
}) {
  const router = useRouter();
  const [batch, setBatch] = useState<Batch>(initialBatch);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<'all' | 'exact' | 'likely' | 'possible' | 'none' | 'error' | 'no_action'>('all');
  const [activeItem, setActiveItem] = useState<Item | null>(null);
  const [applying, setApplying] = useState(false);

  // ─── Data fetch ───────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    const [statusRes, itemsRes] = await Promise.all([
      fetch(`/api/snoonu-import/${batchId}/status`).then((r) => r.json()),
      fetch(`/api/snoonu-import/${batchId}/items?limit=200`).then((r) => r.json()),
    ]);
    if (statusRes.ok) {
      const p = statusRes.data as StatusPayload;
      setBatch(p.batch);
    }
    if (itemsRes.ok) {
      setItems(itemsRes.data.items as Item[]);
    }
    setLoading(false);
  }, [batchId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      // Stop polling once the batch settles
      if (batch.status === 'applied' || batch.status === 'cancelled') return;
      void refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [batch.status, refresh]);

  // ─── Derived ──────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'error') return items.filter((i) => i.status === 'error');
    if (filter === 'no_action') return items.filter((i) => !i.review_action && i.status !== 'error');
    return items.filter((i) => i.match_status === filter);
  }, [items, filter]);

  const reviewed = items.filter((i) => i.review_action).length;
  const pendingReview = items.filter((i) => !i.review_action && i.status === 'matched').length;

  function toggleSelect(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function toggleSelectAll() {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((i) => i.id)));
  }

  async function setItemAction(itemId: number, action: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`/api/snoonu-import/${batchId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Failed: ${data.error?.message}`);
      return;
    }
    await refresh();
  }

  async function bulkAction(action: 'create_new' | 'update_existing' | 'skip' | 'needs_manual') {
    if (selected.size === 0) return;
    const res = await fetch(`/api/snoonu-import/${batchId}/bulk-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_ids: [...selected], action }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Failed: ${data.error?.message}`);
      return;
    }
    setSelected(new Set());
    await refresh();
  }

  async function enrichAll() {
    if (!confirm('Run AI enrichment on every item missing bilingual fields? (Uses Haiku tokens)')) return;
    const res = await fetch(`/api/snoonu-import/${batchId}/enrich-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ only_missing: true, include_image_qc: false }),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(`Enrich failed: ${data.error?.message}`);
      return;
    }
    alert(`Enriched: ${data.data.enriched}\nSkipped: ${data.data.skipped}\nTokens: ${data.data.tokens.input} in / ${data.data.tokens.output} out`);
    await refresh();
  }

  async function applyAll() {
    if (!confirm(`Apply ${reviewed} reviewed items to your catalog?`)) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/snoonu-import/${batchId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Apply failed: ${data.error?.message}`);
        return;
      }
      alert(`Applied: ${data.data.applied}\nSkipped: ${data.data.skipped}\nFailed: ${data.data.failed}`);
      await refresh();
      router.refresh();
    } finally {
      setApplying(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  const isExtracting = batch.status === 'extracting' || batch.status === 'pending';
  const progressPct =
    batch.total_items > 0
      ? Math.round((batch.extracted_count / batch.total_items) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Progress strip */}
      <Card>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={batch.status} />
            <span className="text-sm text-muted-foreground">
              {batch.extracted_count} / {batch.total_items} extracted
              {batch.image_failed_count > 0 && (
                <span className="text-red-600 ml-2">• {batch.image_failed_count} image fails</span>
              )}
              {batch.blocked_count > 0 && (
                <span className="text-red-600 ml-2">• {batch.blocked_count} blocked</span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">
              <strong className="text-foreground tabular-nums">{reviewed}</strong> reviewed •{' '}
              <strong className="text-foreground tabular-nums">{pendingReview}</strong> pending
            </span>
            {batch.status === 'review_ready' && (
              <Button size="sm" variant="secondary" onClick={enrichAll}>
                ✨ AI fill missing
              </Button>
            )}
          </div>
        </div>
        {isExtracting && (
          <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </Card>

      {/* Filters */}
      <Card className="!py-3">
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="text-muted-foreground text-xs uppercase tracking-wide mr-1">Filter:</span>
          {(['all', 'none', 'likely', 'exact', 'possible', 'no_action', 'error'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1 text-xs ${
                filter === f
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-muted'
              }`}
            >
              {f === 'no_action' ? 'No action yet' : f}
            </button>
          ))}
        </div>
      </Card>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <Card className="border-primary/50 bg-primary/5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm font-medium">{selected.size} selected</div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => bulkAction('create_new')}>
                Create new
              </Button>
              <Button size="sm" variant="ghost" onClick={() => bulkAction('update_existing')}>
                Update existing
              </Button>
              <Button size="sm" variant="ghost" onClick={() => bulkAction('skip')}>
                Skip
              </Button>
              <Button size="sm" variant="ghost" onClick={() => bulkAction('needs_manual')}>
                Manual
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Items table */}
      <Card className="!p-0 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">No items match this filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === filtered.length && filtered.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="px-3 py-2 w-14">Image</th>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-left">Match</th>
                <th className="px-3 py-2 text-left">Variants</th>
                <th className="px-3 py-2 text-left">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const variantCount = item.raw_payload?.variant_count ?? 0;
                return (
                  <tr
                    key={item.id}
                    className="border-t hover:bg-muted/20 cursor-pointer"
                    onClick={(e) => {
                      if ((e.target as HTMLElement).tagName === 'INPUT') return;
                      setActiveItem(item);
                    }}
                  >
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleSelect(item.id)}
                      />
                    </td>
                    <td className="px-3 py-3">
                      {item.imported_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imported_image_url}
                          alt=""
                          className="h-10 w-10 rounded object-cover bg-muted"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded bg-muted flex items-center justify-center text-[10px] text-muted-foreground">
                          {item.image_status === 'failed' ? '✕' : '—'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 max-w-md">
                      <div className="font-medium truncate">
                        {item.extracted_name_en || <em className="text-muted-foreground">No name</em>}
                      </div>
                      <div className="text-xs text-muted-foreground truncate" dir="rtl">
                        {item.extracted_name_ar || '—'}
                      </div>
                      {item.error_message && (
                        <div className="text-xs text-red-600 mt-0.5 truncate">⚠ {item.error_message}</div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-mono text-xs">{item.generated_sku ?? '—'}</div>
                      {item.extracted_brand && (
                        <div className="text-xs text-muted-foreground">{item.extracted_brand}</div>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {item.extracted_price != null ? (
                        <>
                          {item.extracted_discount_price != null && (
                            <span className="text-xs text-muted-foreground line-through mr-1">
                              {item.extracted_price}
                            </span>
                          )}
                          <span className="font-medium">
                            {item.extracted_discount_price ?? item.extracted_price} QAR
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <MatchPill status={item.match_status} confidence={item.match_confidence} />
                      {item.matched_product_sku && (
                        <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                          → {item.matched_product_sku}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {variantCount > 0 ? (
                        <Badge variant="muted">
                          {variantCount} {variantCount === 1 ? 'variant' : 'variants'}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      {item.review_action ? (
                        <Badge variant="default">
                          {ACTION_BADGE[item.review_action] ?? item.review_action}
                        </Badge>
                      ) : (
                        <ActionButtons
                          item={item}
                          onPick={(action, body) => setItemAction(item.id, action, body)}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* Apply bar */}
      {reviewed > 0 && batch.status === 'review_ready' && (
        <div className="sticky bottom-4 z-10">
          <Card className="border-primary shadow-lg flex items-center justify-between">
            <div className="text-sm">
              <strong className="tabular-nums">{reviewed}</strong> items ready to apply
              {pendingReview > 0 && (
                <span className="text-muted-foreground ml-2">
                  ({pendingReview} still pending)
                </span>
              )}
            </div>
            <Button onClick={applyAll} disabled={applying}>
              {applying ? 'Applying…' : `Apply ${reviewed} items →`}
            </Button>
          </Card>
        </div>
      )}

      {/* Drawer */}
      {activeItem && (
        <ItemDrawer
          item={activeItem}
          onClose={() => setActiveItem(null)}
          onAction={async (action, body) => {
            await setItemAction(activeItem.id, action, body);
            setActiveItem(null);
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'applied'
      ? 'bg-green-100 text-green-800'
      : status === 'review_ready'
      ? 'bg-blue-100 text-blue-800'
      : status === 'error'
      ? 'bg-red-100 text-red-800'
      : 'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function MatchPill({ status, confidence }: { status: string; confidence: number | null }) {
  const meta = MATCH_PILL[status] ?? MATCH_PILL.pending!;
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${TONE_CLS[meta.tone]}`}>
      {meta.label}
      {confidence != null && <span className="ml-1 tabular-nums opacity-75">{Math.round(confidence * 100)}%</span>}
    </span>
  );
}

function ActionButtons({
  item,
  onPick,
}: {
  item: Item;
  onPick: (action: string, body?: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex gap-1">
      {item.match_status === 'none' && (
        <Button size="sm" onClick={() => onPick('create_new')}>
          Create
        </Button>
      )}
      {(item.match_status === 'exact' || item.match_status === 'likely') && item.matched_product_sku && (
        <Button
          size="sm"
          onClick={() => onPick('update_existing', { matched_product_sku: item.matched_product_sku })}
        >
          Update
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => onPick('skip')}>
        Skip
      </Button>
    </div>
  );
}

function ItemDrawer({
  item,
  onClose,
  onAction,
}: {
  item: Item;
  onClose: () => void;
  onAction: (action: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [enriching, setEnriching] = useState(false);
  const enriched = item.raw_payload?.enriched ?? null;
  const qcReport = item.raw_payload?.image_quality_report ?? null;

  async function runEnrich() {
    setEnriching(true);
    try {
      // batchId isn't passed into the drawer — read it from the URL
      const parts = window.location.pathname.split('/');
      const batchId = parts[parts.indexOf('snoonu-import') + 1];
      const r = await fetch(`/api/snoonu-import/${batchId}/items/${item.id}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_image_qc: true }),
      });
      const data = await r.json();
      if (!data.ok) alert(`Enrich failed: ${data.error?.message}`);
      else window.location.reload();
    } finally {
      setEnriching(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-background w-full max-w-2xl h-full overflow-y-auto border-l shadow-2xl">
        <div className="sticky top-0 bg-background border-b px-6 py-3 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Item #{item.id}</div>
            <div className="font-medium truncate">{item.extracted_name_en ?? '—'}</div>
          </div>
          <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Image */}
          {item.imported_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imported_image_url}
              alt=""
              className="w-full max-w-sm rounded border bg-muted mx-auto"
            />
          )}

          {/* Fields */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="SKU (generated)" value={item.generated_sku} mono />
            <Field label="Source SKU" value={item.extracted_sku} mono />
            <Field label="Brand" value={item.extracted_brand} />
            <Field label="Barcode" value={item.extracted_barcode} mono />
            <Field
              label="Price"
              value={item.extracted_price != null ? `${item.extracted_price} QAR` : null}
            />
            <Field
              label="Discount"
              value={item.extracted_discount_price != null ? `${item.extracted_discount_price} QAR` : null}
            />
          </div>

          <Field label="English description" value={item.extracted_description_en} multiline />
          <Field label="Arabic description" value={item.extracted_description_ar} multiline rtl />

          {/* Variants */}
          {item.raw_payload?.variants && item.raw_payload.variants.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Detected variants
              </div>
              <div className="flex flex-wrap gap-1.5">
                {item.raw_payload.variants.map((v, i) => (
                  <Badge key={i} variant="muted">
                    {v.variant_type}: {v.variant_value}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* AI enrichment */}
          {!enriched && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm flex items-center justify-between">
              <div>
                <div className="font-medium">AI enrichment</div>
                <div className="text-xs text-muted-foreground">
                  Auto-fill missing Arabic, descriptions, keywords + score image
                </div>
              </div>
              <Button size="sm" onClick={runEnrich} disabled={enriching}>
                {enriching ? 'Running…' : '✨ Enrich'}
              </Button>
            </div>
          )}

          {enriched && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm space-y-2">
              <div className="font-medium text-emerald-900 flex items-center justify-between">
                <span>AI-filled fields</span>
                <span className="text-xs">Confidence {Math.round(enriched.confidence * 100)}%</span>
              </div>
              {item.ai_filled_fields?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {item.ai_filled_fields.map((f) => (
                    <Badge key={f} variant="success">{f}</Badge>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 mt-2 text-xs">
                <div>
                  <div className="font-medium">Name (EN)</div>
                  <div>{enriched.name_en}</div>
                </div>
                <div dir="rtl">
                  <div className="font-medium">Name (AR)</div>
                  <div>{enriched.name_ar}</div>
                </div>
              </div>
              {enriched.keywords_en?.length > 0 && (
                <div className="text-xs">
                  <div className="font-medium text-emerald-900 mb-1">Keywords</div>
                  <div className="flex flex-wrap gap-1">
                    {enriched.keywords_en.map((k, i) => (
                      <span key={i} className="rounded bg-emerald-100 px-1.5 py-0.5">{k}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Image QC */}
          {qcReport && (
            <div
              className={`rounded-md border p-3 text-sm ${
                qcReport.score >= 0.7
                  ? 'border-green-200 bg-green-50'
                  : qcReport.score >= 0.4
                  ? 'border-amber-200 bg-amber-50'
                  : 'border-red-200 bg-red-50'
              }`}
            >
              <div className="font-medium">
                Image QC score: {Math.round(qcReport.score * 100)}%
              </div>
              {qcReport.issues.length > 0 && (
                <div className="text-xs mt-1">
                  Issues: <strong>{qcReport.issues.join(', ')}</strong>
                </div>
              )}
              {qcReport.notes && <div className="text-xs mt-1 italic">{qcReport.notes}</div>}
            </div>
          )}

          {/* Match details */}
          {item.matched_product_sku && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
              <div className="font-medium text-amber-900">
                {item.match_status === 'exact' ? 'Exact match' : 'Likely match'}: {item.matched_product_sku}
              </div>
              <div className="text-xs text-amber-700 mt-0.5">
                Confidence {Math.round((item.match_confidence ?? 0) * 100)}% — {item.match_reasons.join(', ')}
              </div>
            </div>
          )}

          {/* Image quality */}
          {item.image_quality_issues?.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
              <div className="font-medium text-red-900">Image quality issues</div>
              <div className="text-xs text-red-700 mt-0.5">{item.image_quality_issues.join(', ')}</div>
            </div>
          )}

          <a
            href={item.source_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-primary hover:underline break-all"
          >
            View on Snoonu →
          </a>
        </div>

        {/* Action footer */}
        <div className="sticky bottom-0 bg-background border-t px-6 py-3 flex flex-wrap gap-2 justify-end">
          <Button variant="ghost" onClick={() => onAction('skip')}>
            Skip
          </Button>
          {item.matched_product_sku && (
            <>
              <Button
                variant="ghost"
                onClick={() => onAction('link_variant', { matched_product_sku: item.matched_product_sku })}
              >
                Link as variant
              </Button>
              <Button onClick={() => onAction('update_existing', { matched_product_sku: item.matched_product_sku })}>
                Update existing
              </Button>
            </>
          )}
          <Button onClick={() => onAction('create_new')}>Create new</Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  multiline,
  rtl,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  multiline?: boolean;
  rtl?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-0.5">{label}</div>
      <div
        className={`text-sm ${mono ? 'font-mono' : ''} ${multiline ? 'whitespace-pre-wrap' : 'truncate'}`}
        dir={rtl ? 'rtl' : 'ltr'}
      >
        {value ?? <em className="text-muted-foreground">—</em>}
      </div>
    </div>
  );
}
