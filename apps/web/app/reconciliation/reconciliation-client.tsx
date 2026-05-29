/**
 * /reconciliation client component — Phase 13A.6.
 *
 * Handles:
 *   - 4 platform upload cards (file picker + auto-detected platform hint)
 *   - Recent imports table with status pills
 *   - Start-comparison form (pick baseline + targets)
 *   - Recent runs table with summary chips
 */
'use client';

import { useState, useMemo, Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Badge } from '@/components/ui';

type Platform = 'snoonu' | 'talabat' | 'rafeeq' | 'shopify' | 'internal';

type ImportRow = {
  id: number;
  platform: string;
  label: string | null;
  source_filename: string | null;
  total_rows: number;
  parsed_rows: number;
  matched_rows: number;
  unmatched_rows: number;
  status: string;
  created_at: string;
  column_mapping?: Record<string, string>;
  prefix_mapping?: Record<string, string[]>;
  category_hint_headers?: string[];
  detected_headers?: string[];
};

type ImportPreview = {
  import: ImportRow;
  sample_size: number;
  field_population: Record<string, { populated: number; pct: number }>;
  category_diagnostics?: {
    category_column_mapped_from: string | null;
    subcategory_column_mapped_from: string | null;
    sample_size: number;
    category_populated: number;
    category_population_pct: number;
    category_missing_count: number;
    source_breakdown: Record<string, number>;
    top_categories: Array<{ name: string; count: number }>;
  };
  rows: Array<{
    id: number;
    source_sku: string | null;
    barcode: string | null;
    name_en: string | null;
    name_ar: string | null;
    brand: string | null;
    price: number | null;
    raw_category?: string | null;
    category_name?: string | null;
    category_source?: string | null;
    category_missing?: boolean;
  }>;
};

type RunRow = {
  id: number;
  label: string | null;
  baseline_platform: string;
  target_platforms: string[];
  findings_total: number;
  findings_by_type: Record<string, number>;
  status: string;
  created_at: string;
};

const PLATFORM_META: Record<Platform, { label: string; icon: string; accent: string }> = {
  snoonu: { label: 'Snoonu', icon: '🥇', accent: 'border-amber-300 bg-amber-50' },
  talabat: { label: 'Talabat', icon: '🍔', accent: 'border-orange-200 bg-orange-50' },
  rafeeq: { label: 'Rafeeq', icon: '🛵', accent: 'border-blue-200 bg-blue-50' },
  shopify: { label: 'Shopify', icon: '🛍️', accent: 'border-emerald-200 bg-emerald-50' },
  internal: { label: 'Internal Catalog', icon: '📦', accent: 'border-slate-200 bg-slate-50' },
};

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'muted'> = {
  pending: 'muted',
  parsing: 'warning',
  normalizing: 'warning',
  matching: 'warning',
  ready: 'success',
  completed: 'success',
  error: 'destructive',
  archived: 'muted',
  running: 'warning',
  cancelled: 'muted',
};

export default function ReconciliationClient({
  initialImports,
  initialRuns,
}: {
  initialImports: ImportRow[];
  initialRuns: RunRow[];
}) {
  const router = useRouter();
  const [imports, setImports] = useState<ImportRow[]>(initialImports);
  const [runs, setRuns] = useState<RunRow[]>(initialRuns);

  // Upload state — one row per active upload
  const [uploading, setUploading] = useState<Record<Platform, boolean>>({} as Record<Platform, boolean>);
  const [uploadErr, setUploadErr] = useState<Record<Platform, string | null>>({} as Record<Platform, string | null>);

  // Run-creation form
  const [baselineId, setBaselineId] = useState<number | ''>('');
  const [targetIds, setTargetIds] = useState<number[]>([]);
  const [runLabel, setRunLabel] = useState('');
  const [runStarting, setRunStarting] = useState(false);

  // Cleanup state
  const [cleaning, setCleaning] = useState(false);

  // Inline diagnostic accordion
  const [expanded, setExpanded] = useState<number | null>(null);
  const [previewCache, setPreviewCache] = useState<Record<number, ImportPreview>>({});

  async function togglePreview(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (previewCache[id]) return;
    const res = await fetch(`/api/reconciliation/imports/${id}`).then((r) => r.json());
    if (res.ok) {
      setPreviewCache((c) => ({ ...c, [id]: res.data as ImportPreview }));
    }
  }

  // Index imports by platform for the dropdown UX
  const importsByPlatform = useMemo(() => {
    const m: Partial<Record<string, ImportRow[]>> = {};
    for (const imp of imports) {
      if (!m[imp.platform]) m[imp.platform] = [];
      m[imp.platform]!.push(imp);
    }
    return m;
  }, [imports]);

  const snoonuImports = importsByPlatform['snoonu'] ?? [];
  const nonSnoonuImports = imports.filter((i) => i.platform !== 'snoonu' && i.status === 'ready');

  async function refreshImports() {
    const res = await fetch('/api/reconciliation/imports?limit=30').then((r) => r.json());
    if (res.ok) setImports(res.data.imports);
  }

  async function refreshRuns() {
    const res = await fetch('/api/reconciliation/runs?limit=20').then((r) => r.json());
    if (res.ok) setRuns(res.data.runs);
  }

  async function handleUpload(platform: Platform, file: File) {
    setUploading((s) => ({ ...s, [platform]: true }));
    setUploadErr((s) => ({ ...s, [platform]: null }));
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('platform', platform);
      const res = await fetch('/api/reconciliation/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!data.ok) {
        setUploadErr((s) => ({ ...s, [platform]: data.error?.message ?? 'Upload failed' }));
        return;
      }
      await refreshImports();
    } catch (e) {
      setUploadErr((s) => ({ ...s, [platform]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setUploading((s) => ({ ...s, [platform]: false }));
    }
  }

  async function cleanupBrokenRuns() {
    setCleaning(true);
    try {
      // 1. Audit
      const auditRes = await fetch('/api/reconciliation/runs/audit').then((r) => r.json());
      if (!auditRes.ok) {
        alert(`Audit failed: ${auditRes.error?.message ?? 'unknown'}`);
        return;
      }
      const audited = (auditRes.data.runs ?? []) as Array<{
        id: number;
        label: string | null;
        health: 'ok' | 'degraded' | 'broken';
        findings_total: number;
        findings_with_no_product_ids: number;
        findings_with_no_snapshots: number;
        findings_with_orphan_baseline: number;
        findings_with_orphan_target: number;
      }>;

      const targets = audited.filter((r) => r.health === 'broken' || r.health === 'degraded');
      if (targets.length === 0) {
        alert('No broken or degraded runs found. Nothing to clean up.');
        return;
      }

      // 2. Confirm
      const idList = targets.map((r) => r.id).join(', ');
      const breakdown = targets
        .slice(0, 10)
        .map(
          (r) =>
            `  #${r.id} [${r.health}] — ${r.findings_total} findings` +
            (r.findings_with_no_product_ids > 0
              ? `, ${r.findings_with_no_product_ids} with no product IDs`
              : '') +
            (r.findings_with_no_snapshots > 0
              ? `, ${r.findings_with_no_snapshots} with no snapshots`
              : ''),
        )
        .join('\n');
      const more = targets.length > 10 ? `\n  …and ${targets.length - 10} more` : '';

      const confirmed = window.confirm(
        `This will delete runs: ${idList}\n\n` +
          `${targets.length} runs total. Only reconciliation_runs + reconciliation_findings will be deleted.\n` +
          `Platform imports are NOT affected.\n\n` +
          `Breakdown:\n${breakdown}${more}\n\n` +
          `Proceed?`,
      );
      if (!confirmed) return;

      // 3. Purge each
      let deleted = 0;
      let failed = 0;
      const failures: Array<{ id: number; reason: string }> = [];

      for (const r of targets) {
        try {
          const res = await fetch(`/api/reconciliation/runs/${r.id}/purge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: `PURGE_RUN_${r.id}` }),
          });
          const data = await res.json();
          if (data.ok) deleted++;
          else {
            failed++;
            failures.push({ id: r.id, reason: data.error?.message ?? 'unknown' });
          }
        } catch (e) {
          failed++;
          failures.push({ id: r.id, reason: e instanceof Error ? e.message : String(e) });
        }
      }

      // 4. Report + refresh
      const failureLines =
        failures.length > 0
          ? '\n\nFailures:\n' + failures.slice(0, 5).map((f) => `  #${f.id}: ${f.reason}`).join('\n')
          : '';
      alert(`Deleted ${deleted} runs. Failed: ${failed}.${failureLines}`);
      await refreshRuns();
    } finally {
      setCleaning(false);
    }
  }

  async function startRun() {
    if (!baselineId || targetIds.length === 0) return;
    setRunStarting(true);
    try {
      const res = await fetch('/api/reconciliation/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: runLabel || undefined,
          baseline_import_id: baselineId,
          target_import_ids: targetIds,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Failed: ${data.error?.message ?? 'unknown'}`);
        return;
      }
      await refreshRuns();
      router.push(`/reconciliation/${data.data.run_id}`);
    } finally {
      setRunStarting(false);
    }
  }

  function toggleTarget(id: number) {
    setTargetIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  }

  return (
    <div className="space-y-6">
      {/* Upload zone */}
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
          1. Upload platform exports
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {(['snoonu', 'talabat', 'rafeeq', 'shopify'] as Platform[]).map((p) => (
            <UploadCard
              key={p}
              platform={p}
              busy={uploading[p] ?? false}
              error={uploadErr[p] ?? null}
              onPick={(file) => handleUpload(p, file)}
              count={(importsByPlatform[p] ?? []).length}
            />
          ))}
        </div>
      </div>

      {/* Recent imports */}
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-2">
          Recent imports
        </h2>
        <Card className="!p-0 overflow-hidden">
          {imports.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No imports yet. Upload a file above to get started.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Platform</th>
                  <th className="px-3 py-2 text-left">File</th>
                  <th className="px-3 py-2 text-right">Rows</th>
                  <th className="px-3 py-2 text-right">Matched</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Created</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((imp) => (
                  <Fragment key={imp.id}>
                    <tr
                      className={`border-t cursor-pointer hover:bg-muted/20 ${
                        imp.parsed_rows === 0 ? 'bg-red-50/40' : ''
                      }`}
                      onClick={() => togglePreview(imp.id)}
                    >
                      <td className="px-3 py-2 capitalize font-medium">{imp.platform}</td>
                      <td className="px-3 py-2 max-w-xs truncate text-muted-foreground">
                        {imp.label ?? imp.source_filename ?? '—'}
                        <span className="text-xs ml-2">{expanded === imp.id ? '▾' : '▸'}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {imp.parsed_rows === 0 ? (
                          <span className="text-red-600">{imp.parsed_rows}</span>
                        ) : (
                          imp.parsed_rows
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={imp.matched_rows > 0 ? 'text-emerald-700' : 'text-muted-foreground'}>
                          {imp.matched_rows}
                        </span>
                        <span className="text-muted-foreground"> / {imp.parsed_rows}</span>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={STATUS_VARIANT[imp.status] ?? 'muted'}>{imp.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {new Date(imp.created_at).toLocaleString()}
                      </td>
                    </tr>
                    {expanded === imp.id && (
                      <tr className="bg-muted/30 border-t">
                        <td colSpan={6} className="px-4 py-3">
                          <PreviewBlock data={previewCache[imp.id]} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Start a run */}
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
          2. Compare Snoonu against other platforms
        </h2>
        <Card>
          {snoonuImports.length === 0 || nonSnoonuImports.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Need at least one ready <strong>Snoonu</strong> import and one ready
              non-Snoonu import to start a comparison.
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Baseline (Snoonu)
                </label>
                <select
                  value={baselineId}
                  onChange={(e) => setBaselineId(Number(e.target.value) || '')}
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
                >
                  <option value="">Pick a Snoonu import…</option>
                  {snoonuImports
                    .filter((i) => i.status === 'ready')
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        #{i.id} — {i.label ?? i.source_filename ?? 'untitled'} ({i.parsed_rows} rows)
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Target platforms
                </label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {nonSnoonuImports.map((i) => {
                    const active = targetIds.includes(i.id);
                    return (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => toggleTarget(i.id)}
                        className={`rounded-md border px-3 py-1.5 text-sm transition ${
                          active
                            ? 'border-primary bg-primary/10 ring-1 ring-primary'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <span className="capitalize font-medium">{i.platform}</span>
                        <span className="text-muted-foreground ml-1.5">#{i.id}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={runLabel}
                  onChange={(e) => setRunLabel(e.target.value)}
                  placeholder="e.g. Weekly catalog sync"
                  className="mt-1 w-full rounded-md border px-3 py-2 text-sm bg-background"
                />
              </div>

              <div className="flex justify-end pt-1">
                <Button onClick={startRun} disabled={!baselineId || targetIds.length === 0 || runStarting}>
                  {runStarting ? 'Comparing…' : `Start comparison →`}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Recent runs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Recent runs
          </h2>
          <button
            onClick={cleanupBrokenRuns}
            disabled={cleaning}
            className="rounded border border-red-300 bg-red-50 text-red-800 hover:bg-red-100 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            title="Audit recent runs and delete any with broken/degraded findings. Does not touch imports."
          >
            {cleaning ? 'Scanning…' : '🗑 Delete broken/degraded runs'}
          </button>
        </div>
        <Card className="!p-0 overflow-hidden">
          {runs.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No runs yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Run</th>
                  <th className="px-3 py-2 text-left">Compared</th>
                  <th className="px-3 py-2 text-right">Findings</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Created</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t hover:bg-muted/20">
                    <td className="px-3 py-2 font-medium">#{r.id}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      <span className="capitalize">{r.baseline_platform}</span>
                      {' → '}
                      <span className="capitalize">{r.target_platforms.join(', ')}</span>
                      {r.label && <div>{r.label}</div>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.findings_total}</td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_VARIANT[r.status] ?? 'muted'}>{r.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <a href={`/reconciliation/${r.id}`} className="text-primary hover:underline text-xs font-medium">
                        View →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Preview block (per-import diagnostic accordion) ───────────────────────

function PreviewBlock({ data }: { data: ImportPreview | undefined }) {
  if (!data) {
    return <div className="text-xs text-muted-foreground">Loading preview…</div>;
  }
  const imp = data.import;
  const mapping = imp.column_mapping ?? {};
  const prefixMapping = imp.prefix_mapping ?? {};
  const hintHeaders = imp.category_hint_headers ?? [];
  const headers = imp.detected_headers ?? [];
  const mappedHeaders = new Set(Object.values(mapping));
  for (const arr of Object.values(prefixMapping)) for (const h of arr) mappedHeaders.add(h);
  for (const h of hintHeaders) mappedHeaders.add(h);
  const unmapped = headers.filter((h) => !mappedHeaders.has(h));
  const pop = data.field_population;

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Column mapping */}
        <div>
          <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Detected column mapping
          </div>
          {Object.keys(mapping).length === 0 && Object.keys(prefixMapping).length === 0 ? (
            <div className="text-red-600">
              ⚠ No columns mapped. The platform detector couldn&apos;t recognize any headers.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {Object.entries(mapping).map(([field, header]) => (
                <li key={field} className="flex items-center gap-2">
                  <span className="font-mono text-emerald-700">{field}</span>
                  <span className="text-muted-foreground">←</span>
                  <span className="font-mono truncate">{header}</span>
                </li>
              ))}
              {Object.entries(prefixMapping).map(([field, list]) => (
                <li key={`prefix-${field}`} className="flex items-start gap-2">
                  <span className="font-mono text-amber-700">{field}</span>
                  <span className="text-muted-foreground">←</span>
                  <span className="font-mono truncate" title={list.join('\n')}>
                    {list.length} prefix-matched columns
                    <span className="text-muted-foreground"> (first non-empty wins)</span>
                  </span>
                </li>
              ))}
              {hintHeaders.length > 0 && (
                <li className="flex items-start gap-2">
                  <span className="font-mono text-purple-700">category_hint</span>
                  <span className="text-muted-foreground">←</span>
                  <span className="font-mono truncate" title={hintHeaders.join('\n')}>
                    {hintHeaders.join(', ')}
                  </span>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Field population */}
        <div>
          <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Field population (sample of {data.sample_size})
          </div>
          <ul className="space-y-0.5">
            {Object.entries(pop).map(([field, p]) => (
              <li key={field} className="flex items-center gap-2">
                <span
                  className={`font-mono ${
                    p.populated === 0 ? 'text-red-600' : p.pct < 0.5 ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {field}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {p.populated}/{data.sample_size}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Unmapped headers */}
        <div>
          <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">
            Unmapped headers ({unmapped.length})
          </div>
          {unmapped.length === 0 ? (
            <div className="text-muted-foreground">All headers were mapped.</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {unmapped.map((h) => (
                <span key={h} className="rounded bg-background border px-1.5 py-0.5 font-mono">
                  {h}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Category diagnostics — Phase 13B.17 */}
      {data.category_diagnostics && (
        <div className="rounded-md border bg-background p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium text-muted-foreground uppercase tracking-wide">
              Category extraction
            </div>
            <a
              href={`/reconciliation/imports/${imp.id}`}
              className="text-[11px] text-primary hover:underline"
            >
              Review & edit categories →
            </a>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Mapping */}
            <div>
              <div className="text-muted-foreground mb-0.5">Mapped from</div>
              <div className="space-y-0.5">
                <div>
                  <span className="text-muted-foreground">category ←</span>{' '}
                  {data.category_diagnostics.category_column_mapped_from ? (
                    <span className="font-mono text-emerald-700">{data.category_diagnostics.category_column_mapped_from}</span>
                  ) : (
                    <span className="text-red-600">no column — inference only</span>
                  )}
                </div>
                <div>
                  <span className="text-muted-foreground">subcategory ←</span>{' '}
                  {data.category_diagnostics.subcategory_column_mapped_from ? (
                    <span className="font-mono text-emerald-700">{data.category_diagnostics.subcategory_column_mapped_from}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            </div>

            {/* Population + sources */}
            <div>
              <div className="text-muted-foreground mb-0.5">Coverage</div>
              <div>
                <span
                  className={`font-mono ${
                    data.category_diagnostics.category_population_pct < 0.5
                      ? 'text-red-600'
                      : data.category_diagnostics.category_population_pct < 0.9
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                  }`}
                >
                  {Math.round(data.category_diagnostics.category_population_pct * 100)}%
                </span>{' '}
                <span className="text-muted-foreground">
                  ({data.category_diagnostics.category_populated} / {data.category_diagnostics.sample_size})
                </span>
              </div>
              {data.category_diagnostics.category_missing_count > 0 && (
                <div className="text-red-600 mt-1">
                  {data.category_diagnostics.category_missing_count} missing
                </div>
              )}
              <div className="mt-1 text-[10px] space-y-0.5">
                {Object.entries(data.category_diagnostics.source_breakdown)
                  .filter(([, n]) => n > 0)
                  .map(([src, n]) => (
                    <div key={src}>
                      <span className="text-muted-foreground">{src}:</span>{' '}
                      <span className="tabular-nums">{n}</span>
                    </div>
                  ))}
              </div>
            </div>

            {/* Top categories */}
            <div>
              <div className="text-muted-foreground mb-0.5">
                Top {Math.min(20, data.category_diagnostics.top_categories.length)} categories
              </div>
              {data.category_diagnostics.top_categories.length === 0 ? (
                <div className="text-red-600">No categories detected.</div>
              ) : (
                <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                  {data.category_diagnostics.top_categories.map((c) => (
                    <li key={c.name} className="flex justify-between gap-2">
                      <span className="truncate">{c.name}</span>
                      <span className="text-muted-foreground tabular-nums">{c.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sample rows */}
      <div>
        <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">
          First {data.rows.length} normalized rows
        </div>
        {data.rows.length === 0 ? (
          <div className="text-red-600 text-xs">
            ⚠ No rows in this import. Likely cause: the file&apos;s column headers don&apos;t match any known aliases.
            Send a screenshot of your CSV&apos;s top row to Claude so we can add the missing aliases.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] border">
              <thead className="bg-background">
                <tr>
                  <th className="px-2 py-1 text-left border-b">SKU</th>
                  <th className="px-2 py-1 text-left border-b">Name (EN)</th>
                  <th className="px-2 py-1 text-left border-b">Brand</th>
                  <th className="px-2 py-1 text-left border-b">Raw category</th>
                  <th className="px-2 py-1 text-left border-b">Detected category</th>
                  <th className="px-2 py-1 text-right border-b">Price</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-2 py-1 font-mono">{r.source_sku ?? '—'}</td>
                    <td className="px-2 py-1 max-w-xs truncate">{r.name_en ?? '—'}</td>
                    <td className="px-2 py-1">{r.brand ?? '—'}</td>
                    <td className="px-2 py-1 text-muted-foreground">{r.raw_category ?? '—'}</td>
                    <td className="px-2 py-1">
                      {r.category_missing ? (
                        <span className="text-red-600">missing</span>
                      ) : (
                        <span>
                          {r.category_name ?? '—'}
                          {r.category_source && r.category_source !== 'direct_column' && (
                            <span className="text-[10px] text-muted-foreground ml-1">
                              ({r.category_source.replace('inferred_', '')})
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">{r.price ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Upload card ────────────────────────────────────────────────────────────

function UploadCard({
  platform,
  busy,
  error,
  onPick,
  count,
}: {
  platform: Platform;
  busy: boolean;
  error: string | null;
  onPick: (file: File) => void;
  count: number;
}) {
  const meta = PLATFORM_META[platform];
  return (
    <label
      className={`block rounded-lg border-2 border-dashed p-4 cursor-pointer transition ${meta.accent} hover:border-primary`}
    >
      <input
        type="file"
        accept=".csv,.xlsx,.xls,text/csv"
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
      <div className="flex items-center gap-2">
        <span className="text-2xl">{meta.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">{meta.label}</div>
          <div className="text-xs text-muted-foreground">
            {busy ? 'Uploading…' : count > 0 ? `${count} imports` : 'Drop CSV / XLSX'}
          </div>
        </div>
      </div>
      {error && <div className="text-xs text-red-600 mt-1.5 line-clamp-3">{error}</div>}
    </label>
  );
}
