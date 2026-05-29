/**
 * Import preview client — Phase 13B.18.
 *
 * Paginated row table with category editing + bulk actions.
 */
'use client';

import { useEffect, useState, useCallback } from 'react';
import { Button, Card, Badge } from '@/components/ui';

const CATEGORY_OPTIONS = [
  'Korean Skincare',
  'Makeup',
  'Hair Care',
  'Body Care',
  'Perfumes',
  'Beauty Tools',
  'Bags & Accessories',
  'Nail Care',
  'Gifts & Sets',
  'Kids & Toys',
  'Thai Products',
  'Trending Products',
];

type Row = {
  id: number;
  source_sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  raw_category: string | null;
  category_name: string | null;
  category_source: string | null;
  category_confidence: number | null;
  category_missing: boolean;
  product_type: string | null;
  price: number | null;
  image_url: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  direct_column: 'direct',
  inferred_rule: 'rule',
  inferred_ai: 'ai',
  manual: 'manual',
};

export default function ImportPreviewClient({ importId }: { importId: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 50;

  // Filters
  const [missingOnly, setMissingOnly] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');

  // Selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');

  // Working state
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (missingOnly) params.set('missing', 'true');
    if (sourceFilter) params.set('source', sourceFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    if (searchQ.trim()) params.set('q', searchQ.trim());

    const res = await fetch(`/api/reconciliation/imports/${importId}/rows?${params}`).then((r) => r.json());
    if (res.ok) {
      setRows(res.data.rows);
      setTotal(res.data.total);
    }
  }, [importId, page, missingOnly, sourceFilter, categoryFilter, searchQ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function toggleSelect(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function toggleAll() {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  }

  async function setRowCategory(rowId: number, category: string) {
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/reconciliation/imports/${importId}/set-category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row_ids: [rowId], category_name: category }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function applyBulkCategory() {
    if (selected.size === 0 || !bulkCategory) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/reconciliation/imports/${importId}/set-category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_ids: [...selected],
          category_name: bulkCategory,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(`Applied "${bulkCategory}" to ${data.data.updated} rows.`);
      setSelected(new Set());
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function autoInferMissing() {
    setBusy(true);
    setStatusMsg('Running rule-based inference on missing rows…');
    try {
      const res = await fetch(`/api/reconciliation/imports/${importId}/set-category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_infer_missing: true }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(
        `Auto-infer done: ${data.data.updated} resolved, ${data.data.still_missing} still missing.`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reextractAll() {
    if (!confirm('Re-run the category extractor on EVERY row in this import? This overwrites any non-manual category assignments.')) return;
    setBusy(true);
    setStatusMsg('Re-extracting…');
    try {
      const res = await fetch(`/api/reconciliation/imports/${importId}/set-category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reextract_all: true }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(`Re-extracted ${data.data.scanned} rows. ${data.data.still_missing} still missing.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <Card className="!py-3">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <input
            type="text"
            placeholder="Search name / SKU…"
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setPage(1);
            }}
            className="rounded border px-3 py-1.5 bg-background w-64"
          />
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={missingOnly}
              onChange={(e) => {
                setMissingOnly(e.target.checked);
                setPage(1);
              }}
            />
            Missing only
          </label>
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background text-xs"
          >
            <option value="">Any source</option>
            <option value="direct_column">Direct column</option>
            <option value="inferred_rule">Inferred rule</option>
            <option value="manual">Manual</option>
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background text-xs"
          >
            <option value="">Any category</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={autoInferMissing} disabled={busy}>
              Auto-infer missing
            </Button>
            <Button size="sm" variant="ghost" onClick={reextractAll} disabled={busy}>
              Re-extract all
            </Button>
          </div>
        </div>
        {statusMsg && (
          <div className="mt-2 rounded bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-800">
            {statusMsg}
          </div>
        )}
      </Card>

      {/* Bulk-apply bar */}
      {selected.size > 0 && (
        <Card className="border-primary/40 bg-primary/5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <strong>{selected.size}</strong> selected
            <select
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              className="rounded border px-2 py-1 bg-background text-xs"
            >
              <option value="">Pick a category…</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={applyBulkCategory}
              disabled={!bulkCategory || busy}
            >
              Apply to {selected.size} rows
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        </Card>
      )}

      {/* Rows table */}
      <Card className="!p-0 overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">No rows match the current filters.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={selected.size === rows.length && rows.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">Brand</th>
                <th className="px-3 py-2 text-left">Raw category</th>
                <th className="px-3 py-2 text-left">Detected</th>
                <th className="px-3 py-2 text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={`border-t align-top ${r.category_missing ? 'bg-red-50/30' : ''}`}>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSelect(r.id)}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.source_sku ?? '—'}</td>
                  <td className="px-3 py-2 max-w-xs">
                    <div className="truncate font-medium">{r.name_en ?? '—'}</div>
                    {r.name_ar && <div className="text-xs text-muted-foreground truncate" dir="rtl">{r.name_ar}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.brand ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.raw_category ?? '—'}</td>
                  <td className="px-3 py-2">
                    <select
                      value={r.category_name ?? ''}
                      onChange={(e) => setRowCategory(r.id, e.target.value)}
                      disabled={busy}
                      className={`rounded border px-2 py-1 text-xs bg-background ${
                        r.category_missing ? 'border-red-300' : ''
                      }`}
                    >
                      <option value="">{r.category_missing ? '⚠ missing' : '— pick —'}</option>
                      {/* If the existing category isn't in the canonical list, keep it as an option */}
                      {r.category_name && !CATEGORY_OPTIONS.includes(r.category_name) && (
                        <option value={r.category_name}>{r.category_name} (raw)</option>
                      )}
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    {r.category_source && (
                      <Badge variant="muted">
                        {SOURCE_LABEL[r.category_source] ?? r.category_source}
                        {r.category_confidence != null && (
                          <span className="ml-1 opacity-75 tabular-nums">
                            {Math.round(r.category_confidence * 100)}%
                          </span>
                        )}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.price ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages} — {total} rows
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
    </div>
  );
}
