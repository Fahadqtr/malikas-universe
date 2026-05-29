/**
 * Catalog mapper client — Phase 13D.
 *
 * UI features:
 *   - Pick a Snoonu import to map
 *   - Summary cards (mapped / missing / needs_review)
 *   - Filters (status / source / search)
 *   - Per-row inline editing of catalog fields
 *   - "Paste from Snoonu" modal — paste breadcrumb + URL
 *   - "Read from current browser tab" — calls Chrome MCP (handled server-side)
 *   - Bulk: apply category to selected rows
 *   - Auto-map from raw_payload (export-column parser)
 *   - Export CSV
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button, Card, Badge } from '@/components/ui';

type ImportListItem = {
  id: number;
  label: string | null;
  source_filename: string | null;
  parsed_rows: number;
  status: string;
  created_at: string;
};

type Row = {
  id: number;
  source_sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  normalized_name: string | null;
  image_url: string | null;
  category_name: string | null;
  raw_category: string | null;
  snoonu_catalog: string | null;
  snoonu_category: string | null;
  snoonu_subcategory: string | null;
  snoonu_section: string | null;
  snoonu_collection: string | null;
  snoonu_menu_path: string | null;
  snoonu_catalog_source_url: string | null;
  catalog_source: string | null;
  catalog_confidence: number | null;
  catalog_checked_at: string | null;
};

type Summary = {
  import_id: number;
  total_rows: number;
  mapped: number;
  missing: number;
  via_export: number;
  via_paste: number;
  via_browser: number;
  via_inferred: number;
  last_checked_at: string | null;
} | null;

const SOURCE_COLOR: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'muted'> = {
  export_column: 'success',
  manual_paste: 'default',
  browser_read: 'success',
  inferred: 'warning',
};

export default function CatalogMapperClient({ imports }: { imports: ImportListItem[] }) {
  const [importId, setImportId] = useState<number | ''>(imports[0]?.id ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const limit = 50;

  // Filters
  const [statusFilter, setStatusFilter] = useState<'all' | 'mapped' | 'missing' | 'needs_review'>('missing');
  const [sourceFilter, setSourceFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');

  // Selection
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Working state
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Paste modal
  const [pasteOpen, setPasteOpen] = useState<{ row_id: number; name: string } | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [pasteUrl, setPasteUrl] = useState('');

  // Sections (catalog overview page)
  const [sections, setSections] = useState<Array<{ id: number; catalog_name_en: string; product_count: number | null }>>([]);
  const [sectionsModalOpen, setSectionsModalOpen] = useState(false);
  const [sectionsRawText, setSectionsRawText] = useState('');
  const [sectionsUrl, setSectionsUrl] = useState('');
  const [autoFillResult, setAutoFillResult] = useState<null | {
    scanned: number;
    matched: number;
    low_confidence: number;
    no_match: number;
    by_section: Record<string, number>;
  }>(null);

  const refresh = useCallback(async () => {
    if (!importId) return;
    const params = new URLSearchParams({
      import_id: String(importId),
      page: String(page),
      limit: String(limit),
    });
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (sourceFilter) params.set('source', sourceFilter);
    if (searchQ.trim()) params.set('q', searchQ.trim());

    const res = await fetch(`/api/snoonu-catalog-mapper/rows?${params}`).then((r) => r.json());
    if (res.ok) {
      setRows(res.data.rows);
      setTotal(res.data.total);
      setSummary(res.data.summary);
    }
  }, [importId, page, limit, statusFilter, sourceFilter, searchQ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadSections = useCallback(async () => {
    const res = await fetch('/api/snoonu-catalog-mapper/sections').then((r) => r.json());
    if (res.ok) setSections(res.data.sections);
  }, []);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  async function importSectionsFromPage() {
    if (!sectionsRawText.trim()) return;
    setBusy(true);
    setStatusMsg('Parsing catalog page…');
    try {
      const res = await fetch('/api/snoonu-catalog-mapper/sections/import-from-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          raw_page_text: sectionsRawText,
          source_url: sectionsUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(
        `Parsed ${data.data.parsed.length} sections. ${data.data.inserted} new, ${data.data.skipped} already known. Total in DB: ${data.data.total_sections}.`,
      );
      setSections(data.data.sections);
      setSectionsModalOpen(false);
      setSectionsRawText('');
      setSectionsUrl('');
    } finally {
      setBusy(false);
    }
  }

  async function autoFillFromSections() {
    if (!importId) return;
    if (sections.length === 0) {
      setStatusMsg('No sections imported yet. Import the Snoonu catalog page first.');
      return;
    }
    setBusy(true);
    setStatusMsg(`Matching ${total > 0 ? total : '…'} products against ${sections.length} sections…`);
    try {
      const res = await fetch('/api/snoonu-catalog-mapper/auto-fill-from-sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ import_id: importId, only_missing: true, min_confidence: 0.6 }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setAutoFillResult(data.data);
      setStatusMsg(
        `Auto-fill done: matched ${data.data.matched} / scanned ${data.data.scanned}. ` +
          `Low-confidence skipped: ${data.data.low_confidence}. No match: ${data.data.no_match}.`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function toggleSel(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function applyManualPaste() {
    if (!pasteOpen || !pasteText.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/snoonu-catalog-mapper/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_id: pasteOpen.row_id,
          manual_paste: { input: pasteText, source_url: pasteUrl || undefined },
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setPasteOpen(null);
      setPasteText('');
      setPasteUrl('');
      setStatusMsg(`Updated mapping for product #${data.data.updated > 0 ? pasteOpen.row_id : '?'}.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function autoMap(useInference: boolean) {
    if (!importId) return;
    setBusy(true);
    setStatusMsg('Running auto-map on raw_payload…');
    try {
      const res = await fetch('/api/snoonu-catalog-mapper/auto-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          import_id: importId,
          only_missing: true,
          use_inference_fallback: useInference,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(
        `Auto-map done: scanned ${data.data.scanned}, mapped ${data.data.mapped}, still missing ${data.data.still_missing}.`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function bulkApply() {
    if (selected.size === 0) return;
    const catalog = window.prompt('Catalog (top level, e.g. "Beauty"):');
    if (!catalog) return;
    const category = window.prompt('Category (e.g. "Skincare"):');
    if (!category) return;
    const subcategory = window.prompt('Sub category (optional):');

    setBusy(true);
    try {
      const res = await fetch('/api/snoonu-catalog-mapper/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row_ids: [...selected],
          mapping: {
            snoonu_catalog: catalog,
            snoonu_category: category,
            snoonu_subcategory: subcategory || null,
            catalog_source: 'manual_paste',
            catalog_confidence: 0.9,
          },
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatusMsg(`Failed: ${data.error?.message}`);
        return;
      }
      setStatusMsg(`Applied to ${data.data.updated} rows.`);
      setSelected(new Set());
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!importId) return;
    window.open(`/api/snoonu-catalog-mapper/export?import_id=${importId}`, '_blank');
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      {/* Import picker */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="text-muted-foreground">Snoonu import:</label>
          <select
            value={importId}
            onChange={(e) => {
              setImportId(Number(e.target.value) || '');
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background"
          >
            <option value="">Pick…</option>
            {imports.map((i) => (
              <option key={i.id} value={i.id}>
                #{i.id} — {i.label ?? i.source_filename ?? 'untitled'} ({i.parsed_rows} rows)
              </option>
            ))}
          </select>
          <div className="ml-auto flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => setSectionsModalOpen(true)} disabled={busy}>
              📋 Import catalog sections from Snoonu page
            </Button>
            <Button size="sm" variant="secondary" onClick={autoFillFromSections} disabled={busy || !importId || sections.length === 0}>
              ✨ Auto-fill Snoonu catalog ({sections.length} sections)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => autoMap(false)} disabled={busy || !importId}>
              Auto-map (export columns)
            </Button>
            <Button size="sm" variant="ghost" onClick={exportCsv} disabled={!importId}>
              📥 Export CSV
            </Button>
          </div>
        </div>
        {statusMsg && (
          <div className="mt-2 rounded bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-800">
            {statusMsg}
          </div>
        )}
      </Card>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard label="Total Snoonu rows" value={summary.total_rows} />
          <SummaryCard label="Mapped" value={summary.mapped} tone="green" />
          <SummaryCard label="Missing catalog" value={summary.missing} tone="red" />
          <SummaryCard
            label="By source"
            valueText={`export:${summary.via_export} · paste:${summary.via_paste} · browser:${summary.via_browser} · inferred:${summary.via_inferred}`}
          />
        </div>
      )}

      {/* Sections detected from Snoonu catalog page */}
      {sections.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium text-sm">
              {sections.length} Snoonu catalog sections detected
            </div>
            <Button size="sm" variant="ghost" onClick={() => setSectionsModalOpen(true)}>
              + Re-import / add more
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {sections.map((s) => (
              <span
                key={s.id}
                className="rounded-full border px-2 py-0.5 bg-background"
                title={s.product_count != null ? `${s.product_count} products` : 'count unknown'}
              >
                {s.catalog_name_en}
                {s.product_count != null && (
                  <span className="text-muted-foreground ml-1">· {s.product_count}</span>
                )}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Auto-fill result diagnostics */}
      {autoFillResult && (
        <Card className="border-emerald-300 bg-emerald-50">
          <div className="flex items-start justify-between gap-3">
            <div className="text-xs space-y-1">
              <div className="font-medium text-emerald-900">
                ✓ Auto-fill matched {autoFillResult.matched} / {autoFillResult.scanned} products
              </div>
              <div className="text-emerald-800">
                <strong>{autoFillResult.matched}</strong> matched ·{' '}
                <strong>{autoFillResult.low_confidence}</strong> low-confidence (skipped) ·{' '}
                <strong>{autoFillResult.no_match}</strong> no section found
              </div>
              {Object.keys(autoFillResult.by_section).length > 0 && (
                <div className="mt-2">
                  <div className="text-emerald-900 font-medium mb-1">Distribution:</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(autoFillResult.by_section)
                      .sort((a, b) => b[1] - a[1])
                      .map(([section, count]) => (
                        <span
                          key={section}
                          className="rounded bg-emerald-100 text-emerald-900 px-1.5 py-0.5"
                        >
                          {section}: <strong>{count}</strong>
                        </span>
                      ))}
                  </div>
                </div>
              )}
            </div>
            <button
              className="text-emerald-700 hover:text-emerald-900"
              onClick={() => setAutoFillResult(null)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </Card>
      )}

      {/* Filters */}
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
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as typeof statusFilter);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background text-xs"
          >
            <option value="missing">Missing catalog</option>
            <option value="needs_review">Needs review</option>
            <option value="mapped">Mapped</option>
            <option value="all">All</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background text-xs"
          >
            <option value="">Any source</option>
            <option value="export_column">Export column</option>
            <option value="manual_paste">Manual paste</option>
            <option value="browser_read">Browser read</option>
            <option value="inferred">Inferred</option>
          </select>
        </div>
      </Card>

      {/* Bulk apply */}
      {selected.size > 0 && (
        <Card className="border-primary/40 bg-primary/5">
          <div className="flex items-center gap-3 text-sm">
            <strong>{selected.size}</strong> selected
            <Button size="sm" onClick={bulkApply} disabled={busy}>
              Apply catalog to selected
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
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
                    onChange={() =>
                      setSelected(selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                  />
                </th>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">Detected category</th>
                <th className="px-3 py-2 text-left">Snoonu catalog path</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Conf.</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-t align-top ${!r.snoonu_category ? 'bg-red-50/30' : ''}`}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleSel(r.id)}
                    />
                  </td>
                  <td className="px-3 py-2 max-w-sm">
                    <div className="truncate font-medium">{r.name_en ?? r.name_ar ?? '—'}</div>
                    <div className="text-xs text-muted-foreground font-mono">{r.source_sku ?? ''}</div>
                    {r.brand && <div className="text-xs text-muted-foreground">{r.brand}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs max-w-xs">
                    <div className="truncate">{r.category_name ?? '—'}</div>
                    {r.raw_category && (
                      <div className="text-[10px] text-muted-foreground truncate">raw: {r.raw_category}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 max-w-md">
                    {r.snoonu_category ? (
                      <div className="text-xs">
                        <div className="font-medium">{r.snoonu_menu_path ?? r.snoonu_category}</div>
                        {r.snoonu_catalog_source_url && (
                          <a
                            href={r.snoonu_catalog_source_url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-[10px] text-primary hover:underline truncate block"
                          >
                            {r.snoonu_catalog_source_url}
                          </a>
                        )}
                      </div>
                    ) : (
                      <span className="text-red-600 text-xs">⚠ missing</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.catalog_source ? (
                      <Badge variant={SOURCE_COLOR[r.catalog_source] ?? 'muted'}>
                        {r.catalog_source.replace('_', ' ')}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {r.catalog_confidence != null ? `${Math.round(r.catalog_confidence * 100)}%` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() =>
                        setPasteOpen({ row_id: r.id, name: r.name_en ?? r.source_sku ?? `#${r.id}` })
                      }
                      className="rounded border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 px-2 py-1 text-xs"
                    >
                      ✏️ Paste from Snoonu
                    </button>
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

      {/* Import catalog sections modal */}
      {sectionsModalOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-2xl max-w-3xl w-full p-6 space-y-3 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="text-lg font-semibold">Import Snoonu catalog sections</h3>
              <p className="text-xs text-muted-foreground">
                Paste the text from the Snoonu Seller Portal catalog overview page (the page
                that lists all your catalog sections — Hair Care, Face Care, etc).
                <strong> Read-only — never writes to Snoonu.</strong>
              </p>
            </div>

            <div>
              <label className="text-xs font-medium">Catalog page URL (optional)</label>
              <input
                type="url"
                value={sectionsUrl}
                onChange={(e) => setSectionsUrl(e.target.value)}
                placeholder="https://merchant.snoonu.com/catalog"
                className="w-full rounded-md border px-3 py-2 text-sm bg-background mt-1 font-mono"
              />
            </div>

            <div>
              <label className="text-xs font-medium">Raw page text</label>
              <textarea
                value={sectionsRawText}
                onChange={(e) => setSectionsRawText(e.target.value)}
                rows={15}
                placeholder={'Paste the catalog page text. Examples of what the parser accepts:\n\nHair Care\n45 products\n\nFace Care (89)\n\nSun Protection · 12\n\nMakeup 67 products'}
                className="w-full rounded-md border px-3 py-2 text-sm bg-background mt-1 font-mono"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Just select all on the Snoonu catalog page (Ctrl+A → Ctrl+C) and paste here.
                The parser will find section names + product counts.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="ghost" onClick={() => setSectionsModalOpen(false)}>Cancel</Button>
              <Button onClick={importSectionsFromPage} disabled={busy || !sectionsRawText.trim()}>
                Parse + Save sections
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Paste-from-Snoonu modal */}
      {pasteOpen && (
        <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-2xl max-w-2xl w-full p-6 space-y-3">
            <div>
              <h3 className="text-lg font-semibold">Paste catalog path from Snoonu</h3>
              <p className="text-xs text-muted-foreground">
                Product: <strong>{pasteOpen.name}</strong>
              </p>
            </div>
            <div>
              <label className="text-xs font-medium">Breadcrumb / catalog path</label>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={'Examples:\n  Beauty > Skincare > Korean Skincare\n  Beauty / Skincare / Korean Skincare\n  Beauty » Skincare » Korean Skincare'}
                rows={5}
                className="w-full rounded-md border px-3 py-2 text-sm bg-background mt-1"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Splits on <code>{'>'}</code>, <code>/</code>, <code>»</code>, <code>·</code>, <code>→</code>, <code>|</code>, or newlines.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium">Snoonu URL (optional)</label>
              <input
                type="url"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                placeholder="https://snoonu.com/qa/en/p/medicube-…"
                className="w-full rounded-md border px-3 py-2 text-sm bg-background mt-1 font-mono"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button variant="ghost" onClick={() => setPasteOpen(null)}>Cancel</Button>
              <Button onClick={applyManualPaste} disabled={busy || !pasteText.trim()}>
                Save mapping
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  valueText,
  tone,
}: {
  label: string;
  value?: number;
  valueText?: string;
  tone?: 'green' | 'red';
}) {
  const cls = tone === 'green' ? 'text-emerald-700' : tone === 'red' ? 'text-red-700' : '';
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${cls}`}>
        {valueText ? <span className="text-xs font-mono">{valueText}</span> : value ?? 0}
      </div>
    </Card>
  );
}
