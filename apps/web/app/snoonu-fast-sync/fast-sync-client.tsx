'use client';

/**
 * Snoonu Fast Sync — client.
 *
 * Step 1 (LIVE): xlsx inspect.
 * Step 2 (TODO 13F.3/4): apply export to platform_products.
 * Step 3 (TODO 13F.5/6): catalog section scrape + apply.
 * Step 4 (TODO 13F.7): rebuild audit queue.
 */

import { useState } from 'react';

type HeaderReport = {
  index: number;
  name: string;
  classification: string;
  filled: number;
  coverage_pct: number;
};

type InspectResult = {
  sheet_name: string;
  row_count: number;
  column_count: number;
  headers: HeaderReport[];
  sample_rows: Array<Record<string, unknown>>;
  classification_summary: Record<string, boolean>;
};

type ImportResult = {
  run_id: number;
  import_id: number;
  total_rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  missing_spi: number;
  missing_name: number;
  prices_captured: number;
  stocks_captured: number;
  availability_captured: number;
  branch_data_coverage_pct: number;
  warnings: string[];
  sample_changes: Array<Record<string, unknown>>;
  next_steps: Array<{ label: string; href: string; phase: string }>;
};

const CLASS_BADGE: Record<string, string> = {
  ID_SPI: 'bg-violet-100 text-violet-800 border-violet-300',
  NAME_EN: 'bg-sky-100 text-sky-800 border-sky-300',
  NAME_AR: 'bg-sky-100 text-sky-800 border-sky-300',
  DESC_EN: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  DESC_AR: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  PRICE_ALI: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  PRICE_AZIZIYAH: 'bg-emerald-100 text-emerald-800 border-emerald-300',
  STOCK_ALI: 'bg-amber-100 text-amber-800 border-amber-300',
  STOCK_AZIZIYAH: 'bg-amber-100 text-amber-800 border-amber-300',
  STOCK_TOTAL: 'bg-amber-50 text-amber-700 border-amber-200',
  AVAIL_ALI: 'bg-lime-100 text-lime-800 border-lime-300',
  AVAIL_AZIZIYAH: 'bg-lime-100 text-lime-800 border-lime-300',
  SKU: 'bg-zinc-100 text-zinc-800 border-zinc-300',
  BARCODE: 'bg-zinc-100 text-zinc-800 border-zinc-300',
  CATEGORY: 'bg-rose-100 text-rose-800 border-rose-300',
  IMAGE: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300',
  OTHER: 'bg-zinc-50 text-zinc-500 border-zinc-200',
};

export function FastSyncClient() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<InspectResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function inspect() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/snoonu-export/inspect', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error?.message ?? `HTTP ${r.status}`);
      } else {
        setResult(j.data as InspectResult);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!file) return;
    if (!confirm(`Import ${result?.row_count ?? 'all'} rows from ${file.name}? This will UPDATE existing Snoonu products and INSERT any new SPIs.`)) return;
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('label', `Fast Sync — ${new Date().toISOString().slice(0, 10)}`);
      const r = await fetch('/api/snoonu-fast-sync/import', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error?.message ?? `HTTP ${r.status}`);
      } else {
        setImportResult(j.data as ImportResult);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="border border-zinc-200 rounded-lg p-5 bg-white">
        <h2 className="font-semibold text-lg mb-1">Step 1 — Upload Snoonu xlsx export</h2>
        <p className="text-sm text-zinc-500 mb-4">
          Read-only inspection. Shows the column map, classification, and
          coverage % so we know what fields are available before we touch
          any database row.
        </p>

        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          <button
            onClick={inspect}
            disabled={!file || busy}
            className="px-4 py-2 rounded-md bg-zinc-900 text-white text-sm disabled:bg-zinc-300"
          >
            {busy ? 'Inspecting…' : 'Inspect file'}
          </button>
          {file && (
            <span className="text-xs text-zinc-500">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </span>
          )}
        </div>

        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
            {error}
          </div>
        )}
      </section>

      {result && (
        <>
          <section className="border border-zinc-200 rounded-lg p-5 bg-white">
            <h2 className="font-semibold text-lg mb-3">Summary</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Cell label="Sheet" value={result.sheet_name} />
              <Cell label="Rows" value={result.row_count.toLocaleString()} />
              <Cell label="Columns" value={result.column_count.toString()} />
              <Cell
                label="Identifier"
                value={result.classification_summary.has_spi ? 'SPI ✓' : '— missing —'}
                tone={result.classification_summary.has_spi ? 'good' : 'warn'}
              />
            </dl>
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              {Object.entries(result.classification_summary).map(([k, v]) => (
                <div
                  key={k}
                  className={`px-2 py-1 rounded border ${
                    v
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-zinc-50 border-zinc-200 text-zinc-500'
                  }`}
                >
                  {v ? '✓' : '✗'} {k.replace(/^has_/, '').replace(/_/g, ' ')}
                </div>
              ))}
            </div>
          </section>

          <section className="border border-zinc-200 rounded-lg p-5 bg-white">
            <h2 className="font-semibold text-lg mb-3">Columns ({result.headers.length})</h2>
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="py-1.5 pr-3">#</th>
                    <th className="py-1.5 pr-3">Class</th>
                    <th className="py-1.5 pr-3">Header</th>
                    <th className="py-1.5 pr-3 text-right">Filled</th>
                    <th className="py-1.5 pr-3 text-right">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {result.headers.map((h) => (
                    <tr key={h.index} className="border-t border-zinc-100">
                      <td className="py-1.5 pr-3 text-zinc-400">{h.index}</td>
                      <td className="py-1.5 pr-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] border ${
                            CLASS_BADGE[h.classification] ?? CLASS_BADGE.OTHER
                          }`}
                        >
                          {h.classification}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 font-mono">{h.name}</td>
                      <td className="py-1.5 pr-3 text-right text-zinc-600">{h.filled}</td>
                      <td className="py-1.5 pr-3 text-right">
                        <span
                          className={
                            h.coverage_pct >= 80
                              ? 'text-emerald-700'
                              : h.coverage_pct >= 30
                                ? 'text-amber-700'
                                : 'text-zinc-400'
                          }
                        >
                          {h.coverage_pct}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border border-zinc-200 rounded-lg p-5 bg-white">
            <h2 className="font-semibold text-lg mb-3">Sample rows</h2>
            <div className="space-y-3">
              {result.sample_rows.map((row, i) => (
                <details key={i} className="border border-zinc-200 rounded">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium bg-zinc-50">
                    Row {i + 1} · {Object.keys(row).length} non-empty fields
                  </summary>
                  <div className="px-3 py-2 text-xs font-mono whitespace-pre-wrap">
                    {Object.entries(row).map(([k, v]) => (
                      <div key={k} className="border-b border-zinc-100 py-1">
                        <span className="text-zinc-500">{k}: </span>
                        <span>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </section>

          <section className="border border-zinc-200 rounded-lg p-5 bg-white">
            <h2 className="font-semibold text-lg mb-1">Step 2 — Import / Update Snoonu Products</h2>
            <p className="text-sm text-zinc-500 mb-4">
              Apply this export to{' '}
              <code className="text-xs">platform_products</code>: upserts by{' '}
              <code className="text-xs">snoonu_spi</code> → fills name EN/AR,
              description EN/AR, per-branch price/stock/availability, plus the{' '}
              <code className="text-xs">snoonu_branches</code> JSONB. Writes
              only to our database — never touches Snoonu.
            </p>
            <button
              onClick={runImport}
              disabled={!file || importing}
              className="px-4 py-2 rounded-md bg-emerald-700 text-white text-sm disabled:bg-zinc-300"
            >
              {importing ? `Importing ${result.row_count} rows…` : `Import / Update ${result.row_count} Snoonu Products`}
            </button>
            <span className="ml-3 text-xs text-zinc-500">
              {file?.name}
            </span>
          </section>

          {importResult && (
            <>
              <section className="border border-emerald-300 bg-emerald-50 rounded-lg p-5">
                <h2 className="font-semibold text-lg mb-3 text-emerald-900">
                  Import complete · run #{importResult.run_id}
                </h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <Cell label="Processed" value={importResult.total_rows.toLocaleString()} tone="good" />
                  <Cell label="Inserted" value={importResult.inserted.toLocaleString()} tone="good" />
                  <Cell label="Updated" value={importResult.updated.toLocaleString()} tone="good" />
                  <Cell label="Unchanged" value={importResult.unchanged.toLocaleString()} />
                  <Cell label="Skipped" value={importResult.skipped.toLocaleString()} tone={importResult.skipped > 0 ? 'warn' : undefined} />
                  <Cell label="Missing SPI" value={importResult.missing_spi.toLocaleString()} tone={importResult.missing_spi > 0 ? 'warn' : undefined} />
                  <Cell label="Missing name" value={importResult.missing_name.toLocaleString()} tone={importResult.missing_name > 0 ? 'warn' : undefined} />
                  <Cell label="Branch coverage" value={`${importResult.branch_data_coverage_pct}%`} tone="good" />
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <Cell label="Prices captured" value={importResult.prices_captured.toLocaleString()} />
                  <Cell label="Stocks captured" value={importResult.stocks_captured.toLocaleString()} />
                  <Cell label="Availability captured" value={importResult.availability_captured.toLocaleString()} />
                </div>

                {importResult.warnings.length > 0 && (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-amber-700">
                      {importResult.warnings.length} warning(s)
                    </summary>
                    <ul className="mt-2 list-disc pl-5 text-zinc-600">
                      {importResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </details>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                  {importResult.next_steps.map((s) => (
                    <a
                      key={s.phase}
                      href={s.href}
                      className="px-3 py-2 text-xs rounded border border-emerald-700 text-emerald-800 bg-white hover:bg-emerald-100"
                    >
                      → {s.label} <span className="text-zinc-400">({s.phase})</span>
                    </a>
                  ))}
                </div>
              </section>

              {importResult.sample_changes.length > 0 && (
                <section className="border border-zinc-200 rounded-lg p-5 bg-white">
                  <h2 className="font-semibold text-lg mb-3">
                    Sample changes ({importResult.sample_changes.length})
                  </h2>
                  <div className="text-xs font-mono space-y-2 max-h-96 overflow-y-auto">
                    {importResult.sample_changes.map((c, i) => (
                      <pre key={i} className="bg-zinc-50 border border-zinc-100 rounded px-2 py-1 whitespace-pre-wrap">
                        {JSON.stringify(c, null, 2)}
                      </pre>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          <section className="border border-amber-200 bg-amber-50 rounded-lg p-4 text-sm text-amber-900">
            <strong>Note — missing from this export:</strong> Category, Image,
            SKU, Barcode. Those still come from the catalog-section scraper
            (Phase 13F.5) and the targeted browser audit (Phase 13E). Once
            this import succeeds, only the truly uncertain products will be
            audited per-page.
          </section>
        </>
      )}
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn';
}) {
  const ring =
    tone === 'good'
      ? 'ring-emerald-200 bg-emerald-50'
      : tone === 'warn'
        ? 'ring-amber-200 bg-amber-50'
        : 'ring-zinc-200 bg-zinc-50';
  return (
    <div className={`rounded px-3 py-2 ring-1 ${ring}`}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
