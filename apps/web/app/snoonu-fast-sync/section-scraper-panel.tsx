'use client';

/**
 * Section scraper panel — Phase 13F.5/6.
 *
 * Shows a grid of known Snoonu catalog sections with last-scrape status.
 * Each section row has:
 *   - status badge (never scraped / OK / errors)
 *   - matched/unmatched counts
 *   - "Open in Snoonu" link (read-only)
 *   - "Apply scrape" textarea that accepts the extractor's JSON output
 *
 * The textarea takes the JSON returned by SNOONU_SECTION_EXTRACTOR_JS
 * (snoonu-section-page-script.ts) and POSTs it to
 * /api/snoonu-fast-sync/apply-catalog-section.
 *
 * Both flows work:
 *   • Operator opens Snoonu portal in another tab, runs the bookmarklet
 *     from the script, copies the JSON, pastes it here.
 *   • Or the Cowork assistant drives Chrome MCP, runs the JS itself, and
 *     submits the JSON via the same endpoint (server-side).
 */

import { useEffect, useState } from 'react';

const KNOWN_SECTIONS = [
  'Hair Care',
  'Face Care',
  'Sun Protection',
  'Masks',
  'Body Care',
  'Dental Care',
  'Beauty Accessories',
  'Beauty Bundle',
  'Makeup',
  'Lashes & Nails',
  'Electronics',
  'Rhode Products Section',
  'Gifts & Special Occasions',
  'Thailand Products',
  'Toys',
  "Women's Essentials",
  'Eid Specials',
];

const PORTAL_BASE = 'https://snoonu-portal.snoonu.com/v2/dashboard/catalog';

type CoverageData = {
  total_snoonu_products: number;
  with_category: number;
  missing_category: number;
  multi_category: number;
  via_section_page: number;
  via_browser_audit: number;
  via_inferred: number;
  high_confidence: number;
  low_confidence: number;
};

type SectionStatus = {
  section_name: string;
  products_found: number;
  products_matched: number;
  products_unmatched: number;
  duplicates_in_section: number;
  last_scraped_at: string | null;
  status: 'running' | 'completed' | 'error';
  last_scrape_id: number | null;
};

type ApplyResult = {
  scrape_id: number;
  section_name: string;
  products_found: number;
  products_matched: number;
  products_unmatched: number;
  duplicates_in_section: number;
  primaries_set: number;
  secondaries_added: number;
  sample_unmatched: Array<Record<string, unknown>>;
  sample_matches: Array<Record<string, unknown>>;
};

export function SectionScraperPanel() {
  const [coverage, setCoverage] = useState<CoverageData | null>(null);
  const [sections, setSections] = useState<SectionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pasteJson, setPasteJson] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ApplyResult>>({});
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/snoonu-fast-sync/catalog-coverage');
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error?.message ?? `HTTP ${r.status}`);
      } else {
        setCoverage(j.data.coverage);
        setSections(j.data.sections);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  function statusFor(name: string): SectionStatus | undefined {
    return sections.find((s) => s.section_name === name);
  }

  async function applyPaste(section: string) {
    const raw = pasteJson[section]?.trim();
    if (!raw) return;
    setApplying(section);
    setError(null);
    try {
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        setError(`Section "${section}": JSON parse failed — ${(e as Error).message}`);
        return;
      }
      if (parsed && parsed.ok === false) {
        setError(`Section "${section}": extractor reported failure — ${parsed.reason}`);
        return;
      }
      const body = {
        section_name: section,
        source_url: parsed.source_url ?? PORTAL_BASE,
        pages_scanned: parsed.pages_scanned ?? 1,
        products: parsed.products ?? [],
      };
      if (!body.products.length) {
        setError(`Section "${section}": no products in payload`);
        return;
      }
      const r = await fetch('/api/snoonu-fast-sync/apply-catalog-section', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error?.message ?? `HTTP ${r.status}`);
      } else {
        setResults((prev) => ({ ...prev, [section]: j.data }));
        // Refresh status grid
        await reload();
      }
    } finally {
      setApplying(null);
    }
  }

  const coveragePct = coverage && coverage.total_snoonu_products > 0
    ? Math.round((coverage.with_category / coverage.total_snoonu_products) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <section className="border border-zinc-200 rounded-lg p-5 bg-white">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-semibold text-lg mb-1">Step 3 — Scrape catalog sections from Snoonu</h2>
            <p className="text-sm text-zinc-500">
              READ-ONLY scrape of each Snoonu catalog section page. Sets{' '}
              <code className="text-xs">snoonu_category</code> (primary) and{' '}
              <code className="text-xs">snoonu_secondary_categories</code> for
              multi-section products. Never opens product detail pages.
            </p>
          </div>
          <button
            onClick={reload}
            className="text-xs px-3 py-1.5 rounded border border-zinc-300 hover:bg-zinc-50"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
            {error}
          </div>
        )}

        {coverage && (
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <KPI label="Snoonu products" value={coverage.total_snoonu_products.toLocaleString()} />
            <KPI label="Mapped" value={`${coverage.with_category.toLocaleString()} (${coveragePct}%)`} tone={coveragePct > 80 ? 'good' : coveragePct > 40 ? 'warn' : 'bad'} />
            <KPI label="Missing" value={coverage.missing_category.toLocaleString()} tone={coverage.missing_category > 0 ? 'warn' : 'good'} />
            <KPI label="Multi-category" value={coverage.multi_category.toLocaleString()} />
            <KPI label="High confidence" value={coverage.high_confidence.toLocaleString()} tone="good" />
          </div>
        )}
      </section>

      <section className="border border-zinc-200 rounded-lg bg-white">
        <div className="px-5 py-3 border-b border-zinc-200 text-sm font-medium">
          Section status
        </div>
        <div className="divide-y divide-zinc-100">
          {KNOWN_SECTIONS.map((name) => {
            const s = statusFor(name);
            const isOpen = expanded === name;
            const result = results[name];
            return (
              <div key={name} className="px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setExpanded(isOpen ? null : name)}
                        className="text-sm font-medium hover:underline"
                      >
                        {isOpen ? '▾' : '▸'} {name}
                      </button>
                      <SectionBadge status={s} />
                    </div>
                    {s && (
                      <div className="text-xs text-zinc-500 mt-1">
                        {s.products_found} found · {s.products_matched} matched · {s.products_unmatched} unmatched
                        {s.duplicates_in_section > 0 ? ` · ${s.duplicates_in_section} duplicates` : ''}
                        {s.last_scraped_at && ` · ${new Date(s.last_scraped_at).toLocaleString()}`}
                      </div>
                    )}
                  </div>
                  <a
                    href={`${PORTAL_BASE}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2.5 py-1 rounded border border-zinc-300 hover:bg-zinc-50 whitespace-nowrap"
                  >
                    Open Snoonu →
                  </a>
                </div>

                {isOpen && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-zinc-600">
                      Paste the JSON output from the section extractor (or
                      let the Cowork assistant submit it via Chrome MCP).
                    </div>
                    <textarea
                      value={pasteJson[name] ?? ''}
                      onChange={(e) =>
                        setPasteJson((prev) => ({ ...prev, [name]: e.target.value }))
                      }
                      placeholder='{ "section_name": "Hair Care", "source_url": "...", "pages_scanned": 1, "products": [...] }'
                      className="w-full text-xs font-mono border border-zinc-200 rounded p-2 h-32"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => applyPaste(name)}
                        disabled={applying === name || !pasteJson[name]?.trim()}
                        className="px-3 py-1.5 rounded bg-emerald-700 text-white text-xs disabled:bg-zinc-300"
                      >
                        {applying === name ? 'Applying…' : 'Apply scrape'}
                      </button>
                      <button
                        onClick={() => setPasteJson((p) => ({ ...p, [name]: '' }))}
                        className="px-3 py-1.5 rounded border border-zinc-300 text-xs hover:bg-zinc-50"
                      >
                        Clear
                      </button>
                    </div>

                    {result && (
                      <div className="mt-2 text-xs bg-emerald-50 border border-emerald-200 rounded p-3 text-emerald-900">
                        <div className="font-medium mb-1">
                          ✓ Applied · scrape #{result.scrape_id}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <span>matched: <b>{result.products_matched}</b></span>
                          <span>unmatched: <b>{result.products_unmatched}</b></span>
                          <span>primaries set: <b>{result.primaries_set}</b></span>
                          <span>secondaries added: <b>{result.secondaries_added}</b></span>
                        </div>
                        {result.sample_unmatched.length > 0 && (
                          <details className="mt-2">
                            <summary className="cursor-pointer">
                              {result.sample_unmatched.length} unmatched samples
                            </summary>
                            <ul className="mt-1 list-disc pl-5">
                              {result.sample_unmatched.map((u: any, i) => (
                                <li key={i}>{u.name} {u.spi ? `(${u.spi})` : ''}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <RebuildAuditQueuePanel />

      <section className="border border-zinc-200 bg-zinc-50 rounded-lg p-4 text-xs text-zinc-700">
        <strong>How the scrape works:</strong> The extractor walks every
        catalog list page (auto-paginates up to 30 pages), collects every
        product's SPI + name + price + image, deduplicates, and returns JSON.
        It never opens product detail, never clicks Save/Edit/Delete/Update
        buttons. Submitting the JSON here writes only to our local DB —
        Snoonu is never modified.
      </section>
    </div>
  );
}

// ─── Step 4: rebuild audit queue ─────────────────────────────────────────────

type RebuildResult = {
  import_id: number;
  before: Record<string, number>;
  after: Record<string, number>;
  pruned: number;
  enqueued_new: number;
  sample_queue: Array<{
    audit_id: number;
    product_id: number | null;
    name_en: string | null;
    snoonu_category: string | null;
    catalog_confidence: number | null;
    priority: number;
    reason: string | null;
  }>;
};

function RebuildAuditQueuePanel() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rebuild() {
    if (!confirm('Rebuild audit queue? This will SKIP pending audits whose products are already resolved by Fast Sync, and enqueue new audits for products that are still uncertain.')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/snoonu-fast-sync/rebuild-audit-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setError(j.error?.message ?? `HTTP ${r.status}`);
      } else {
        setResult(j.data as RebuildResult);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-zinc-200 rounded-lg p-5 bg-white">
      <h2 className="font-semibold text-lg mb-1">Step 4 — Rebuild audit queue</h2>
      <p className="text-sm text-zinc-500 mb-4">
        Skips pending audits already resolved by Fast Sync (xlsx + section
        scrape). Re-enqueues only the truly uncertain products (missing
        catalog, low confidence, missing branch data, unresolved findings).
      </p>

      <button
        onClick={rebuild}
        disabled={busy}
        className="px-4 py-2 rounded-md bg-zinc-900 text-white text-sm disabled:bg-zinc-300"
      >
        {busy ? 'Rebuilding…' : 'Rebuild browser audit queue'}
      </button>

      {error && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <KPI label="Pruned (resolved)" value={result.pruned.toLocaleString()} tone="good" />
            <KPI label="Newly enqueued" value={result.enqueued_new.toLocaleString()} />
            <KPI label="Pending now" value={result.after.pending?.toLocaleString() ?? '0'} tone={(result.after.pending ?? 0) < 50 ? 'good' : 'warn'} />
            <KPI label="Already audited" value={result.after.audited?.toLocaleString() ?? '0'} />
          </div>

          <div className="text-xs text-zinc-500">
            Before: pending {result.before.pending}, audited {result.before.audited}, verified {result.before.verified}, skipped {result.before.skipped}
          </div>

          {result.sample_queue.length > 0 && (
            <details className="border border-zinc-200 rounded">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium bg-zinc-50">
                Next-up sample ({result.sample_queue.length})
              </summary>
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left text-zinc-500">
                    <th className="py-1.5 px-2">Pri</th>
                    <th className="py-1.5 px-2">Reason</th>
                    <th className="py-1.5 px-2">Product</th>
                    <th className="py-1.5 px-2">Category</th>
                    <th className="py-1.5 px-2 text-right">Conf</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sample_queue.map((r) => (
                    <tr key={r.audit_id} className="border-t border-zinc-100">
                      <td className="py-1 px-2 text-zinc-400">{r.priority}</td>
                      <td className="py-1 px-2">
                        <code className="text-[10px]">{r.reason}</code>
                      </td>
                      <td className="py-1 px-2">{r.name_en ?? '—'}</td>
                      <td className="py-1 px-2 text-zinc-500">{r.snoonu_category ?? '—'}</td>
                      <td className="py-1 px-2 text-right text-zinc-500">
                        {r.catalog_confidence !== null ? Number(r.catalog_confidence).toFixed(2) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          <a
            href="/snoonu-browser-audit"
            className="inline-block px-3 py-2 text-xs rounded border border-emerald-700 text-emerald-800 bg-white hover:bg-emerald-100"
          >
            → Open browser audit queue
          </a>
        </div>
      )}
    </section>
  );
}

function SectionBadge({ status }: { status?: SectionStatus }) {
  if (!status) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 border border-zinc-200">
        not scraped
      </span>
    );
  }
  const tone =
    status.status === 'error'
      ? 'bg-red-100 text-red-800 border-red-200'
      : status.products_unmatched > 0
        ? 'bg-amber-100 text-amber-800 border-amber-200'
        : 'bg-emerald-100 text-emerald-800 border-emerald-200';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${tone}`}>
      {status.status}
    </span>
  );
}

function KPI({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' }) {
  const ring =
    tone === 'good'
      ? 'ring-emerald-200 bg-emerald-50'
      : tone === 'warn'
        ? 'ring-amber-200 bg-amber-50'
        : tone === 'bad'
          ? 'ring-red-200 bg-red-50'
          : 'ring-zinc-200 bg-zinc-50';
  return (
    <div className={`rounded px-3 py-2 ring-1 ${ring}`}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-medium text-sm">{value}</div>
    </div>
  );
}
