/**
 * RunDashboard client component — Phase 13A.
 *
 * Fetches run summary + paginated findings, renders tabs by finding_type
 * and a clean diff table.
 */
'use client';

import { useEffect, useMemo, useState, Fragment } from 'react';
import { Card, Badge } from '@/components/ui';

type Run = {
  id: number;
  label: string | null;
  baseline_platform: string;
  target_platforms: string[];
  findings_total: number;
  findings_by_type: Record<string, number>;
  status: string;
  created_at: string;
};

type RelatedProduct = {
  id: number;
  source_sku: string | null;
  name_en: string | null;
  name_ar: string | null;
  normalized_name: string | null;
  barcode: string | null;
  matched_master_sku: string | null;
  price: number | null;
  image_url: string | null;
};

/** Phase 13B.10 — full snapshot frozen by the comparator. */
type ProductSnapshot = {
  platform: string;
  product_id: number | null;
  name_en: string | null;
  name_ar: string | null;
  normalized_name: string | null;
  source_sku: string | null;
  matched_master_sku: string | null;
  barcode: string | null;
  brand: string | null;
  category: string | null;
  variant_color: string | null;
  variant_size: string | null;
  variant_pack: number | null;
  image_url: string | null;
  image_filename: string | null;
  price: number | null;
  discount_price: number | null;
  stock_quantity: number | null;
  stock_status: string | null;
  platform_status: string | null;
};

/**
 * Display-name fallback chain. Reads snapshot first, then joined relational
 * row, then the comparator's pre-computed value, then a final SKU/barcode
 * fallback. Never returns blank.
 *
 * Order:
 *   snapshot.name_en →
 *   snapshot.name_ar →
 *   snapshot.normalized_name →
 *   joined.name_en/name_ar/normalized_name →
 *   precomputedValue →
 *   snapshot.source_sku →
 *   snapshot.matched_master_sku →
 *   master_sku from the finding →
 *   snapshot.barcode →
 *   "Unknown product"
 */
function displayName(
  snapshot: ProductSnapshot | null | undefined,
  joined: RelatedProduct | null | undefined,
  precomputed: string | null | undefined,
  masterSku?: string | null,
): string {
  if (snapshot?.name_en) return snapshot.name_en;
  if (snapshot?.name_ar) return snapshot.name_ar;
  if (snapshot?.normalized_name) return snapshot.normalized_name;
  if (joined?.name_en) return joined.name_en;
  if (joined?.name_ar) return joined.name_ar;
  if (joined?.normalized_name) return joined.normalized_name;
  if (precomputed && precomputed.trim().length > 0) return precomputed;
  if (snapshot?.source_sku) return snapshot.source_sku;
  if (snapshot?.matched_master_sku) return snapshot.matched_master_sku;
  if (joined?.source_sku) return joined.source_sku;
  if (masterSku) return masterSku;
  if (snapshot?.barcode) return snapshot.barcode;
  if (joined?.barcode) return joined.barcode;
  return 'Unknown product';
}

/** SKU-line fallback. */
function displaySku(
  snapshot: ProductSnapshot | null | undefined,
  joined: RelatedProduct | null | undefined,
  masterSku?: string | null,
): string {
  if (snapshot?.source_sku) return snapshot.source_sku;
  if (joined?.source_sku) return joined.source_sku;
  if (snapshot?.matched_master_sku) return snapshot.matched_master_sku;
  if (joined?.matched_master_sku) return joined.matched_master_sku;
  if (masterSku) return masterSku;
  if (snapshot?.barcode) return `barcode: ${snapshot.barcode}`;
  if (joined?.barcode) return `barcode: ${joined.barcode}`;
  return '';
}

type Finding = {
  id: number;
  run_id: number;
  master_sku: string | null;
  baseline_platform: string;
  target_platform: string;
  finding_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  baseline_value: string | null;
  target_value: string | null;
  diff_meta: Record<string, unknown>;
  suggested_action: string | null;
  resolution_status: string;
  created_at: string;
  // Phase 13B
  confidence?: number | null;
  candidate_pairs?: Array<{ id: number; score: number; tier: string }> | null;
  differing_tokens?: string[] | null;
  variant_family_id?: string | null;
  // Phase 13B.10 — self-contained snapshots
  baseline_snapshot?: ProductSnapshot | null;
  target_snapshot?: ProductSnapshot | null;
  matching_reason?: string | null;
  baseline?: RelatedProduct | null;
  target?: RelatedProduct | null;
};

const FINDING_LABEL: Record<string, string> = {
  missing_on_target: 'Missing on target',
  missing_on_baseline: 'Missing on Snoonu',
  price_mismatch: 'Price mismatch',
  discount_mismatch: 'Discount mismatch',
  name_en_mismatch: 'Name (EN) mismatch',
  name_ar_mismatch: 'Name (AR) mismatch',
  brand_mismatch: 'Brand mismatch',
  category_mismatch: 'Category mismatch',
  barcode_mismatch: 'Barcode mismatch',
  duplicate_on_target: 'Duplicate on target',
  image_mismatch: 'Image mismatch',
  image_filename_mismatch: 'Image filename mismatch',
  stock_mismatch: 'Stock mismatch',
  status_mismatch: 'Status mismatch',
  variant_mismatch: 'Variant mismatch',
  possible_match: 'Possible match',
  variant_missing_on_target: 'Variant missing on target',
  variant_missing_on_baseline: 'Variant missing on Snoonu',
};

// Tab grouping — drives the top-level tabs in the UI
const TAB_GROUPS: Array<{ id: string; label: string; types: string[] }> = [
  { id: 'all', label: 'All', types: [] },
  { id: 'possible', label: 'Possible matches', types: ['possible_match'] },
  { id: 'missing', label: 'Missing products', types: ['missing_on_target', 'missing_on_baseline'] },
  { id: 'variants', label: 'Variant issues', types: ['variant_missing_on_target', 'variant_missing_on_baseline', 'variant_mismatch'] },
  { id: 'price', label: 'Price / discount', types: ['price_mismatch', 'discount_mismatch'] },
  { id: 'stock', label: 'Stock / status', types: ['stock_mismatch', 'status_mismatch'] },
  { id: 'images', label: 'Image issues', types: ['image_mismatch', 'image_filename_mismatch'] },
  { id: 'names', label: 'Names / brand / category', types: ['name_en_mismatch', 'name_ar_mismatch', 'brand_mismatch', 'category_mismatch'] },
  { id: 'other', label: 'Other', types: ['barcode_mismatch', 'duplicate_on_target'] },
];

const SEVERITY_VARIANT: Record<Finding['severity'], 'destructive' | 'warning' | 'muted' | 'success'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'warning',
  low: 'muted',
};

export default function RunDashboard({
  runId,
  initialRun,
}: {
  runId: number;
  initialRun: Run;
}) {
  const [run, setRun] = useState<Run>(initialRun);
  const [summary, setSummary] = useState<{
    by_type: Record<string, number>;
    by_severity: Record<string, number>;
    by_platform: Record<string, Record<string, number>>;
  } | null>(null);

  const [findings, setFindings] = useState<Finding[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  // Filters
  const [activeTab, setActiveTab] = useState<string>('all');
  const [type, setType] = useState<string>('');
  const [platform, setPlatform] = useState<string>('');
  const [severity, setSeverity] = useState<string>('');
  const [resolution, setResolution] = useState<string>('pending');
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  // Mapping-resolution debug toast
  const [mappingToast, setMappingToast] = useState<null | {
    finding_id: number;
    master_via: string;
    baseline_via: string;
    target_via: string;
    synthetic_note: string;
    mapping_id: number;
  }>(null);

  // Fetch summary
  useEffect(() => {
    void fetch(`/api/reconciliation/runs/${runId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setRun(d.data.run);
          setSummary(d.data.summary);
        }
      });
  }, [runId]);

  // When the user picks a tab that maps to a specific set of types, drive the
  // server-side filter via the strongest type. For multi-type tabs we fetch
  // wide and filter client-side below.
  const tabGroup = useMemo(() => TAB_GROUPS.find((g) => g.id === activeTab) ?? TAB_GROUPS[0]!, [activeTab]);

  // Fetch findings whenever filters change
  useEffect(() => {
    const params = new URLSearchParams({
      run_id: String(runId),
      page: String(page),
      limit: String(limit),
    });
    if (type) params.set('type', type);
    else if (tabGroup.types.length === 1) params.set('type', tabGroup.types[0]!);
    if (platform) params.set('platform', platform);
    if (severity) params.set('severity', severity);
    if (resolution) params.set('resolution', resolution);

    void fetch(`/api/reconciliation/findings?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          let rows = d.data.findings as Finding[];
          // Multi-type tab: filter client side
          if (tabGroup.types.length > 1) {
            rows = rows.filter((r) => tabGroup.types.includes(r.finding_type));
          }
          setFindings(rows);
          setTotal(d.data.total);
        }
      });
  }, [runId, page, type, platform, severity, resolution, tabGroup]);

  async function repairSnapshots() {
    if (!confirm('Re-build baseline/target snapshots for every finding in this run that has empty snapshots? Safe to run repeatedly.')) return;
    try {
      const res = await fetch(`/api/reconciliation/runs/${runId}/repair-snapshots`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Repair failed: ${data.error?.message}`);
        return;
      }
      alert(
        `Scanned: ${data.data.scanned}\n` +
          `Already complete: ${data.data.already_complete ?? 0}\n` +
          `Repaired: ${data.data.repaired}\n` +
          `  • Baseline-side only: ${data.data.baseline_repaired ?? 0}\n` +
          `  • Target-side only:   ${data.data.target_repaired ?? 0}\n` +
          `  • Both sides:         ${data.data.both_repaired ?? 0}\n` +
          `By-design null sides: ${(data.data.by_design_baseline_null ?? 0) + (data.data.by_design_target_null ?? 0)}\n` +
          `Truly orphaned (deleted products): ${data.data.truly_orphaned ?? 0}\n\n` +
          (data.data.explanation ?? ''),
      );
      // Re-fetch findings so the freshly-repaired rows show up
      const params = new URLSearchParams({
        run_id: String(runId),
        page: String(page),
        limit: String(limit),
      });
      const fresh = await fetch(`/api/reconciliation/findings?${params.toString()}`).then((r) => r.json());
      if (fresh.ok) {
        setFindings(fresh.data.findings as Finding[]);
        setTotal(fresh.data.total);
      }
    } catch (e) {
      alert(`Repair error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function resolveFinding(
    finding: Finding,
    action: 'mark_matched' | 'ignore' | 'confirm_missing' | 'create_mapping' | 'dismiss',
  ) {
    setResolvingId(finding.id);
    try {
      const res = await fetch(`/api/reconciliation/findings/${finding.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Failed: ${data.error?.message ?? 'unknown'}`);
        return;
      }

      // Surface the SKU-fallback path for mappings so the operator knows
      // whether a "real" SKU was used or whether we fell back to synthetic.
      if (data.data.mapping_id && data.data.mapping_resolved_via) {
        const rv = data.data.mapping_resolved_via as {
          master_sku: string;
          baseline_sku: string;
          target_sku: string;
        };
        const syntheticSides: string[] = data.data.mapping_synthetic_sides ?? [];
        const synthetic = data.data.mapping_is_synthetic
          ? `\n⚠ Synthetic SKU used on: ${syntheticSides.join(', ')}. Review this mapping.`
          : '';
        setMappingToast({
          finding_id: finding.id,
          master_via: rv.master_sku,
          baseline_via: rv.baseline_sku,
          target_via: rv.target_sku,
          synthetic_note: synthetic,
          mapping_id: data.data.mapping_id,
        });
      }

      // Remove from current view
      setFindings((rows) => rows.filter((r) => r.id !== finding.id));
      setTotal((n) => Math.max(0, n - 1));
    } finally {
      setResolvingId(null);
    }
  }

  // Per-tab counts derived from summary
  const tabCounts = useMemo(() => {
    const byType = summary?.by_type ?? run.findings_by_type ?? {};
    const counts: Record<string, number> = {};
    for (const tab of TAB_GROUPS) {
      if (tab.id === 'all') {
        counts[tab.id] = Object.values(byType).reduce((a, b) => a + Number(b), 0);
      } else {
        counts[tab.id] = tab.types.reduce((sum, t) => sum + Number(byType[t] ?? 0), 0);
      }
    }
    return counts;
  }, [summary, run]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Total findings" value={run.findings_total} />
        <SummaryCard
          label="Critical / high"
          value={(summary?.by_severity?.critical ?? 0) + (summary?.by_severity?.high ?? 0)}
          tone="red"
        />
        <SummaryCard label="Medium" value={summary?.by_severity?.medium ?? 0} tone="amber" />
        <SummaryCard label="Low" value={summary?.by_severity?.low ?? 0} tone="muted" />
      </div>

      {/* Repair toolbar */}
      <div className="flex items-center justify-end">
        <button
          onClick={repairSnapshots}
          className="rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 px-3 py-1.5 text-xs font-medium"
          title="Backfill baseline/target snapshots for findings showing blank rows"
        >
          🔧 Repair snapshots
        </button>
      </div>

      {/* Mapping resolution debug toast */}
      {mappingToast && (
        <Card className="border-emerald-300 bg-emerald-50">
          <div className="flex items-start justify-between gap-3 text-xs">
            <div>
              <div className="font-medium text-emerald-900">
                ✓ Mapping #{mappingToast.mapping_id} created
                <span className="text-emerald-700 ml-2 font-normal">(finding #{mappingToast.finding_id})</span>
              </div>
              <div className="mt-1 font-mono text-emerald-800 space-y-0.5">
                <div>master_sku  ← {mappingToast.master_via}</div>
                <div>baseline_sku ← {mappingToast.baseline_via}</div>
                <div>target_sku   ← {mappingToast.target_via}</div>
              </div>
              {mappingToast.synthetic_note && (
                <div className="mt-2 rounded bg-amber-100 text-amber-900 px-2 py-1 whitespace-pre-wrap">
                  {mappingToast.synthetic_note}
                </div>
              )}
            </div>
            <button
              className="text-emerald-700 hover:text-emerald-900"
              onClick={() => setMappingToast(null)}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </Card>
      )}

      {/* Tabs */}
      <Card className="!py-3">
        <div className="flex flex-wrap items-center gap-2">
          {TAB_GROUPS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setType('');
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                activeTab === tab.id ? 'bg-primary text-primary-foreground border-primary' : 'hover:bg-muted'
              }`}
            >
              {tab.label}
              {(tabCounts[tab.id] ?? 0) > 0 && <span className="opacity-75 ml-1">{tabCounts[tab.id]}</span>}
            </button>
          ))}
        </div>

        {/* Secondary filters */}
        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t text-xs">
          <span className="text-muted-foreground uppercase tracking-wide">Filter:</span>
          <select
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background"
          >
            <option value="">All platforms</option>
            {(run.target_platforms ?? []).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background"
          >
            <option value="">Any severity</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            value={resolution}
            onChange={(e) => {
              setResolution(e.target.value);
              setPage(1);
            }}
            className="rounded border px-2 py-1 bg-background"
          >
            <option value="pending">Pending</option>
            <option value="applied">Resolved</option>
            <option value="dismissed">Dismissed</option>
            <option value="">All</option>
          </select>
        </div>
      </Card>

      {/* Findings table */}
      <Card className="!p-0 overflow-hidden">
        {findings.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">No findings match the current filters.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Severity</th>
                <th className="px-3 py-2 text-left">Finding</th>
                <th className="px-3 py-2 text-left">Snoonu (baseline)</th>
                <th className="px-3 py-2 text-left">Target</th>
                <th className="px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <FindingRow
                  key={f.id}
                  f={f}
                  resolving={resolvingId === f.id}
                  onResolve={resolveFinding}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages} — {total} findings
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

// ─── FindingRow — per-row display + action buttons + debug drawer ──────────

function FindingRow({
  f,
  resolving,
  onResolve,
}: {
  f: Finding;
  resolving: boolean;
  onResolve: (
    f: Finding,
    action: 'mark_matched' | 'ignore' | 'confirm_missing' | 'create_mapping' | 'dismiss',
  ) => void;
}) {
  const [debugOpen, setDebugOpen] = useState(false);
  const isPossible = f.finding_type === 'possible_match';
  const isMissing = f.finding_type === 'missing_on_target' || f.finding_type === 'missing_on_baseline';

  // Price comes preferentially from snapshot (frozen) over the live joined row
  const baselinePrice = f.baseline_snapshot?.price ?? f.baseline?.price ?? null;
  const targetPrice = f.target_snapshot?.price ?? f.target?.price ?? null;

  return (
    <Fragment>
      <tr className="border-t align-top">
        <td className="px-3 py-2 capitalize whitespace-nowrap">
          <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
          {f.confidence != null && (
            <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
              {Math.round(f.confidence * 100)}%
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="font-medium">{FINDING_LABEL[f.finding_type] ?? f.finding_type}</div>
          <div className="text-xs text-muted-foreground capitalize">→ {f.target_platform}</div>
          {f.differing_tokens && f.differing_tokens.length > 0 && (
            <div className="text-[11px] text-muted-foreground mt-1">
              Diff:{' '}
              {f.differing_tokens.slice(0, 6).map((t, i) => (
                <span
                  key={i}
                  className="inline-block rounded bg-amber-100 text-amber-800 px-1 mr-0.5"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          {f.variant_family_id && (
            <div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate max-w-[200px]">
              family: {f.variant_family_id}
            </div>
          )}
        </td>
        <td className="px-3 py-2 max-w-xs">
          <div className="text-xs truncate font-medium">
            {displayName(f.baseline_snapshot, f.baseline, f.baseline_value, f.master_sku)}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate">
            {displaySku(f.baseline_snapshot, f.baseline, f.master_sku)}
          </div>
          {baselinePrice != null && (
            <div className="text-[11px] text-muted-foreground">{baselinePrice} QAR</div>
          )}
        </td>
        <td className="px-3 py-2 max-w-xs">
          <div className="text-xs truncate font-medium">
            {displayName(f.target_snapshot, f.target, f.target_value, f.master_sku)}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono truncate">
            {displaySku(f.target_snapshot, f.target, f.master_sku)}
          </div>
          {targetPrice != null && (
            <div className="text-[11px] text-muted-foreground">{targetPrice} QAR</div>
          )}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <div className="flex flex-wrap gap-1">
            {isPossible && (
              <button
                disabled={resolving}
                onClick={() => onResolve(f, 'mark_matched')}
                className="rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 px-2 py-1 text-[11px] disabled:opacity-50"
              >
                ✓ Mark matched
              </button>
            )}
            {isMissing && (
              <button
                disabled={resolving}
                onClick={() => onResolve(f, 'confirm_missing')}
                className="rounded border border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 px-2 py-1 text-[11px] disabled:opacity-50"
              >
                ✓ Confirm missing
              </button>
            )}
            {!isMissing && (
              <button
                disabled={resolving}
                onClick={() => onResolve(f, 'create_mapping')}
                className="rounded border border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100 px-2 py-1 text-[11px] disabled:opacity-50"
              >
                Create mapping
              </button>
            )}
            <button
              disabled={resolving}
              onClick={() => onResolve(f, 'ignore')}
              className="rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 px-2 py-1 text-[11px] disabled:opacity-50"
            >
              Ignore
            </button>
            <button
              disabled={resolving}
              onClick={() => onResolve(f, 'dismiss')}
              className="rounded border border-gray-200 text-gray-600 hover:bg-gray-50 px-2 py-1 text-[11px] disabled:opacity-50"
            >
              Dismiss
            </button>
            <button
              onClick={() => setDebugOpen((v) => !v)}
              className="rounded border border-gray-200 text-gray-600 hover:bg-gray-50 px-2 py-1 text-[11px]"
              title="Toggle debug snapshot"
            >
              {debugOpen ? '▾ Debug' : '▸ Debug'}
            </button>
          </div>
          {f.suggested_action && (
            <div className="text-[10px] text-muted-foreground mt-1">
              Suggested: {f.suggested_action.replace(/_/g, ' ')}
            </div>
          )}
        </td>
      </tr>
      {debugOpen && (
        <tr className="border-t bg-muted/30">
          <td colSpan={5} className="px-4 py-3 text-[11px]">
            <DebugDrawer f={f} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function DebugDrawer({ f }: { f: Finding }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">Why this fired</div>
        <ul className="space-y-0.5 font-mono">
          <li><span className="text-muted-foreground">finding_type:</span> {f.finding_type}</li>
          <li><span className="text-muted-foreground">matching_reason:</span> {f.matching_reason ?? '—'}</li>
          <li><span className="text-muted-foreground">confidence:</span> {f.confidence != null ? f.confidence.toFixed(3) : '—'}</li>
          <li><span className="text-muted-foreground">severity:</span> {f.severity}</li>
          <li><span className="text-muted-foreground">suggested:</span> {f.suggested_action ?? '—'}</li>
          {f.variant_family_id && (
            <li className="truncate"><span className="text-muted-foreground">family:</span> {f.variant_family_id}</li>
          )}
        </ul>
        {f.differing_tokens && f.differing_tokens.length > 0 && (
          <div className="mt-2">
            <div className="text-muted-foreground">differing_tokens:</div>
            <div className="flex flex-wrap gap-0.5 mt-1">
              {f.differing_tokens.map((t, i) => (
                <span key={i} className="rounded bg-amber-100 text-amber-800 px-1">{t}</span>
              ))}
            </div>
          </div>
        )}
        {f.candidate_pairs && f.candidate_pairs.length > 0 && (
          <div className="mt-2">
            <div className="text-muted-foreground">candidate_pairs:</div>
            <ul className="font-mono mt-1">
              {f.candidate_pairs.map((c, i) => (
                <li key={i}>#{c.id} — {(c.score * 100).toFixed(1)}% ({c.tier})</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div>
          <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">Baseline snapshot</div>
          <pre className="bg-background border rounded p-2 text-[10px] overflow-x-auto whitespace-pre-wrap">
            {f.baseline_snapshot ? JSON.stringify(f.baseline_snapshot, null, 2) : 'null'}
          </pre>
        </div>
        <div>
          <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">Target snapshot</div>
          <pre className="bg-background border rounded p-2 text-[10px] overflow-x-auto whitespace-pre-wrap">
            {f.target_snapshot ? JSON.stringify(f.target_snapshot, null, 2) : 'null'}
          </pre>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'red' | 'amber' | 'muted';
}) {
  const cls =
    tone === 'red'
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
