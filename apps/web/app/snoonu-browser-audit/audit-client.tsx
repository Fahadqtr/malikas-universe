/**
 * Audit client — Phase 13E.5.
 *
 * Operator flow:
 *   1. Pick an import → refresh queue
 *   2. For each row in the queue:
 *      a. Click "🔗 Open in Snoonu" (opens product page in a new Chrome tab)
 *      b. Read the page (the operator visually — no automated clicks)
 *      c. Click "📋 Paste browser snapshot" or "🤖 Read from current tab"
 *      d. Review extracted data
 *      e. Click "✅ Apply audit data" — copies selected fields to platform_products
 *
 * NEVER triggers any write to Snoonu.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button, Card, Badge } from '@/components/ui';

type ImportItem = {
  id: number;
  label: string | null;
  source_filename: string | null;
  parsed_rows: number;
  created_at: string;
};

type ProductRef = {
  id: number;
  source_sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  normalized_name: string | null;
  image_url: string | null;
  price: number | null;
  stock_quantity: number | null;
  category_name: string | null;
  raw_category: string | null;
  snoonu_catalog: string | null;
  snoonu_category: string | null;
  snoonu_subcategory: string | null;
  snoonu_section: string | null;
  snoonu_menu_path: string | null;
  catalog_source: string | null;
  catalog_confidence: number | null;
};

type Branch = {
  name: string;
  stock: number | null;
  price: number | null;
  available: boolean | null;
};

type AuditRow = {
  id: number;
  product_id: number;
  snoonu_product_url: string | null;
  snoonu_product_name: string | null;
  snoonu_catalog: string | null;
  snoonu_category: string | null;
  snoonu_menu_path: string | null;
  snoonu_price: number | null;
  snoonu_stock: number | null;
  snoonu_status: string | null;
  snoonu_image_url: string | null;
  snoonu_branches: Branch[] | null;
  snoonu_secondary_categories: string[] | null;
  has_options: boolean;
  option_groups: unknown;
  variants: unknown;
  audit_status: 'pending' | 'audited' | 'verified' | 'applied' | 'skipped' | 'error';
  audit_priority: number;
  audit_reason: string | null;
  audit_confidence: number | null;
  audited_at: string | null;
  applied_at: string | null;
  product: ProductRef | null;
};

type Progress = {
  import_id: number;
  total_audited: number;
  pending: number;
  audited: number;
  verified: number;
  applied: number;
  skipped: number;
  errored: number;
  options_detected: number;
  catalog_fixed: number;
  price_captured: number;
  branches_captured?: number;
  multi_category?: number;
} | null;

const REASON_LABEL: Record<string, string> = {
  missing_snoonu_catalog: 'Missing catalog',
  low_catalog_confidence: 'Low confidence',
  possible_match_finding: 'Possible match',
  price_mismatch_finding: 'Price mismatch',
  variant_issue_finding: 'Variant issue',
  unspecified: 'Unspecified',
};

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'muted'> = {
  pending: 'muted',
  audited: 'warning',
  verified: 'success',
  applied: 'success',
  skipped: 'muted',
  error: 'destructive',
};

export default function AuditClient({ imports }: { imports: ImportItem[] }) {
  const [importId, setImportId] = useState<number | ''>(imports[0]?.id ?? '');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState<Progress>(null);
  const [byReason, setByReason] = useState<Record<string, { pending: number; total: number }>>({});

  const [statusFilter, setStatusFilter] = useState('pending,audited');
  const [reasonFilter, setReasonFilter] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Paste-snapshot modal
  const [pasteOpen, setPasteOpen] = useState<AuditRow | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [pasteUrl, setPasteUrl] = useState('');

  // Phase 13E.16 — batch orchestrator
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchPreview, setBatchPreview] = useState<null | {
    batch: Array<{ audit_id: number; product_id: number; queue_product_name: string | null; queue_product_sku: string | null; audit_priority: number; audit_reason: string | null }>;
    remaining_pending: number;
  }>(null);

  const refresh = useCallback(
    async (doRefreshQueue = false) => {
      if (!importId) return;
      const params = new URLSearchParams({
        import_id: String(importId),
        page: String(page),
        limit: String(limit),
        status: statusFilter,
      });
      if (reasonFilter) params.set('reason', reasonFilter);
      if (doRefreshQueue) params.set('refresh', 'true');

      const res = await fetch(`/api/snoonu-browser-audit/queue?${params}`).then((r) => r.json());
      if (res.ok) {
        setRows(res.data.rows);
        setTotal(res.data.total);
        setProgress(res.data.summary);
        setByReason(res.data.by_reason ?? {});
      }
    },
    [importId, page, statusFilter, reasonFilter],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function previewNextBatch() {
    if (!importId) return;
    setBusy(true);
    setStatusMsg('Loading next 50 pending audits…');
    try {
      const res = await fetch('/api/snoonu-browser-audit/next-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ import_id: importId, batch_size: 50 }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setBatchPreview({ batch: data.data.batch, remaining_pending: data.data.remaining_pending });
      setBatchModalOpen(true);
      setStatusMsg(
        `Loaded ${data.data.batch_size} audits. ${data.data.remaining_pending} more pending after this batch.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function rebuildQueue() {
    setBusy(true);
    setStatusMsg('Rebuilding audit queue from current data…');
    try {
      await refresh(true);
      setStatusMsg('Queue rebuilt.');
    } finally {
      setBusy(false);
    }
  }

  async function applyAudit(audit: AuditRow, fields: string[] = ['all'], markVerified = true) {
    setBusy(true);
    try {
      const res = await fetch('/api/snoonu-browser-audit/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audit_id: audit.id,
          fields,
          mark_verified: markVerified,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Apply failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(`Applied ${data.data.applied_fields.join(', ')} to product #${data.data.product_id}.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function skipAudit(audit: AuditRow) {
    setBusy(true);
    try {
      const res = await fetch(`/api/snoonu-browser-audit/${audit.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip' }),
      });
      const data = await res.json();
      if (!data.ok) setStatusMsg(`Skip failed: ${data.error?.message}`);
      else setStatusMsg(`Audit ${audit.id} skipped.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function savePastedSnapshot() {
    if (!pasteOpen || !pasteText.trim()) return;
    setBusy(true);
    try {
      // Build a snapshot from plain text. Operator pasted the visible page.
      const snapshot = {
        page_text: pasteText,
        page_url: pasteUrl || null,
        page_title: null,
      };
      const res = await fetch('/api/snoonu-browser-audit/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: pasteOpen.product_id,
          snapshot,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Save failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(
        `Snapshot saved (audit #${data.data.audit_id}, confidence ${Math.round((data.data.confidence ?? 0) * 100)}%).`,
      );
      setPasteOpen(null);
      setPasteText('');
      setPasteUrl('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      {/* Import picker + queue builder */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="text-muted-foreground">Snoonu import:</label>
          <select
            value={importId}
            onChange={(e) => setImportId(Number(e.target.value) || '')}
            className="rounded border px-2 py-1 bg-background"
          >
            <option value="">Pick…</option>
            {imports.map((i) => (
              <option key={i.id} value={i.id}>
                #{i.id} — {i.label ?? i.source_filename ?? 'untitled'} ({i.parsed_rows} rows)
              </option>
            ))}
          </select>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={rebuildQueue} disabled={busy || !importId}>
              🔄 Rebuild audit queue
            </Button>
            <Button size="sm" variant="secondary" onClick={previewNextBatch} disabled={busy || !importId}>
              🤖 Audit next 50
            </Button>
          </div>
        </div>
        {statusMsg && (
          <div className="mt-2 rounded bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-800">
            {statusMsg}
          </div>
        )}
      </Card>

      {/* Progress cards */}
      {progress && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total queued" value={progress.total_audited} />
          <StatCard label="Pending" value={progress.pending} tone={progress.pending > 0 ? 'red' : 'muted'} />
          <StatCard label="Audited" value={progress.audited} tone="amber" />
          <StatCard label="Applied / Verified" value={progress.applied + progress.verified} tone="green" />
          <StatCard label="Options detected" value={progress.options_detected} />
          <StatCard label="Catalog captured" value={progress.catalog_fixed} />
          <StatCard label="Branches captured" value={progress.branches_captured ?? 0} />
          <StatCard label="Cross-listed" value={progress.multi_category ?? 0} tone={progress.multi_category ? 'amber' : 'muted'} />
        </div>
      )}

      {/* Filters */}
      <Card className="!py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground uppercase tracking-wide text-xs">Filter:</span>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background text-xs"
          >
            <option value="pending,audited">Active (pending + audited)</option>
            <option value="pending">Pending only</option>
            <option value="audited">Audited only</option>
            <option value="verified">Verified</option>
            <option value="applied">Applied</option>
            <option value="skipped">Skipped</option>
            <option value="error">Errored</option>
          </select>
          <select
            value={reasonFilter}
            onChange={(e) => {
              setReasonFilter(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background text-xs"
          >
            <option value="">All reasons</option>
            {Object.keys(byReason).map((r) => (
              <option key={r} value={r}>
                {REASON_LABEL[r] ?? r} ({byReason[r]!.pending}/{byReason[r]!.total})
              </option>
            ))}
          </select>
        </div>
      </Card>

      {/* Queue table */}
      <Card className="!p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">
            No audit rows match the current filters. Click <strong>Rebuild audit queue</strong> to populate from current data.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left w-16">Priority</th>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">Current catalog</th>
                <th className="px-3 py-2 text-left">Snoonu audited</th>
                <th className="px-3 py-2 text-left">Reason</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <Badge variant={r.audit_priority <= 20 ? 'destructive' : r.audit_priority <= 40 ? 'warning' : 'muted'}>
                      P{r.audit_priority}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 max-w-xs">
                    <div className="font-medium truncate">
                      {r.product?.name_en ?? r.product?.name_ar ?? '—'}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {r.product?.source_sku ?? ''}
                    </div>
                    {r.product?.brand && (
                      <div className="text-[10px] text-muted-foreground">{r.product.brand}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-xs">
                    <div className="truncate">{r.product?.snoonu_menu_path ?? r.product?.snoonu_category ?? '—'}</div>
                    {r.product?.catalog_source && (
                      <div className="text-[10px] text-muted-foreground">
                        {r.product.catalog_source.replace('_', ' ')}
                        {r.product?.catalog_confidence != null && (
                          <span className="ml-1">· {Math.round(r.product.catalog_confidence * 100)}%</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-md">
                    {r.snoonu_menu_path ? (
                      <>
                        <div className="font-medium truncate">{r.snoonu_menu_path}</div>
                        {/* Secondary categories as chips */}
                        {r.snoonu_secondary_categories && r.snoonu_secondary_categories.length > 0 && (
                          <div className="flex flex-wrap gap-0.5 mt-1">
                            <Badge variant="warning">cross-listed</Badge>
                            {r.snoonu_secondary_categories.map((c) => (
                              <span
                                key={c}
                                className="rounded bg-blue-100 text-blue-800 px-1 py-0.5 text-[10px]"
                              >
                                + {c}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Top-line price + total stock */}
                        {r.snoonu_price != null && (
                          <div className="text-[10px] text-muted-foreground mt-1">
                            Price {r.snoonu_price} QAR · Total stock {r.snoonu_stock ?? '—'}
                          </div>
                        )}
                        {/* Per-branch breakdown */}
                        {r.snoonu_branches && r.snoonu_branches.length > 0 && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 space-y-0.5">
                            {r.snoonu_branches.map((b, i) => (
                              <div key={i} className="flex items-center gap-1">
                                <span className="truncate flex-1" title={b.name}>{b.name.length > 30 ? b.name.slice(0, 28) + '…' : b.name}</span>
                                <span className="font-mono tabular-nums">{b.stock ?? '—'}</span>
                                <span className="tabular-nums">@ {b.price ?? '—'}</span>
                                <span className={b.available ? 'text-emerald-700' : 'text-red-600'}>
                                  {b.available ? '✓' : '✕'}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {r.has_options && (
                          <div className="text-[10px] text-amber-700 mt-1">
                            ⚙ {Array.isArray(r.option_groups) ? (r.option_groups as unknown[]).length : 0} option group(s)
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">— not audited yet —</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Badge variant="muted">{REASON_LABEL[r.audit_reason ?? 'unspecified'] ?? r.audit_reason}</Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <Badge variant={STATUS_VARIANT[r.audit_status] ?? 'muted'}>{r.audit_status}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {r.snoonu_product_url ? (
                        <a
                          href={r.snoonu_product_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="rounded border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 px-2 py-1 text-[11px]"
                        >
                          🔗 Open
                        </a>
                      ) : null}
                      <button
                        onClick={() => setPasteOpen(r)}
                        className="rounded border border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100 px-2 py-1 text-[11px]"
                        disabled={busy}
                      >
                        📋 Paste snapshot
                      </button>
                      {r.audit_status === 'audited' && (
                        <button
                          onClick={() => applyAudit(r, ['all'], true)}
                          className="rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 px-2 py-1 text-[11px]"
                          disabled={busy}
                        >
                          ✅ Apply all
                        </button>
                      )}
                      <button
                        onClick={() => skipAudit(r)}
                        className="rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 px-2 py-1 text-[11px]"
                        disabled={busy}
                      >
                        Skip
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {total > limit && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages} — {total} audits
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Batch-50 orchestrator modal */}
      {batchModalOpen && batchPreview && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-2xl max-w-4xl w-full p-6 space-y-3 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold">Audit next 50 — batch preview</h3>
              <p className="text-xs text-muted-foreground">
                These {batchPreview.batch.length} audits will be processed by Claude using Chrome
                in READ-ONLY mode. {batchPreview.remaining_pending} more pending after this batch.
              </p>
              <div className="text-[11px] text-red-700 mt-2 rounded border border-red-200 bg-red-50 px-2 py-1">
                ⚠ READ-ONLY: Claude will only search + open + read pages. Never clicks
                Save / Submit / Publish / Update Stock / Update Status / Update Price.
                Stops immediately on login challenge or page structure change.
              </div>
            </div>

            <div className="rounded border bg-muted/20 p-2 text-xs">
              <div className="font-medium mb-1">Auto-apply rules</div>
              <ul className="space-y-0.5 ml-4 list-disc">
                <li>Confidence ≥ 0.95 → save + auto-apply</li>
                <li>Confidence 0.75–0.95 → save as <strong>audited</strong> (operator review)</li>
                <li>Confidence &lt; 0.75 → save as <strong>needs_review</strong></li>
              </ul>
            </div>

            <div className="overflow-x-auto max-h-[400px] overflow-y-auto border rounded">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">P</th>
                    <th className="px-2 py-1 text-left">Reason</th>
                    <th className="px-2 py-1 text-left">Product</th>
                    <th className="px-2 py-1 text-left">SKU</th>
                  </tr>
                </thead>
                <tbody>
                  {batchPreview.batch.map((b, i) => (
                    <tr key={b.audit_id} className="border-t">
                      <td className="px-2 py-1 text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1">P{b.audit_priority}</td>
                      <td className="px-2 py-1">{b.audit_reason ?? '—'}</td>
                      <td className="px-2 py-1 max-w-md truncate">{b.queue_product_name ?? '—'}</td>
                      <td className="px-2 py-1 font-mono">{b.queue_product_sku ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded border bg-blue-50 px-3 py-2 text-xs text-blue-900">
              <strong>Next:</strong> Ask Claude in chat to <code>&quot;Run batch 50 now&quot;</code> — Claude will drive
              Chrome through the Snoonu portal for each row in this batch, calling
              <code> /api/snoonu-browser-audit/save-from-browser</code> per product.
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="ghost" onClick={() => { setBatchModalOpen(false); setBatchPreview(null); }}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Paste snapshot modal */}
      {pasteOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-2xl max-w-3xl w-full p-6 space-y-3 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold">Paste Snoonu product page snapshot</h3>
              <p className="text-xs text-muted-foreground">
                Product: <strong>{pasteOpen.product?.name_en ?? pasteOpen.product?.source_sku ?? `#${pasteOpen.product_id}`}</strong>
              </p>
              <div className="text-[11px] text-red-700 mt-1">⚠ READ-ONLY: don&apos;t click any Save/Submit/Publish on Snoonu.</div>
            </div>

            <div>
              <label className="text-xs font-medium">Snoonu product URL</label>
              <input
                type="url"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                placeholder="https://merchant.snoonu.com/products/12345"
                className="w-full rounded-md border px-3 py-2 text-sm bg-background mt-1 font-mono"
              />
            </div>

            <div>
              <label className="text-xs font-medium">Page text (paste from Snoonu product page)</label>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={15}
                placeholder={
                  'Select all on the Snoonu product page (Ctrl+A) and paste here.\n\nThe parser will extract:\n  - product name\n  - breadcrumb / catalog path\n  - price\n  - stock\n  - status\n  - options/variants'
                }
                className="w-full rounded-md border px-3 py-2 text-sm bg-background mt-1 font-mono"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="ghost" onClick={() => setPasteOpen(null)}>
                Cancel
              </Button>
              <Button onClick={savePastedSnapshot} disabled={busy || !pasteText.trim()}>
                💾 Save snapshot
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'green' | 'red' | 'amber' | 'muted';
}) {
  const cls =
    tone === 'green'
      ? 'text-emerald-700'
      : tone === 'red'
      ? 'text-red-700'
      : tone === 'amber'
      ? 'text-amber-700'
      : tone === 'muted'
      ? 'text-muted-foreground'
      : '';
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${cls}`}>{value}</div>
    </Card>
  );
}
