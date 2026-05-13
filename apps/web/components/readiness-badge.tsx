'use client';

/**
 * Readiness UI components — shared across review dashboard, products list,
 * and the product edit page.
 *
 * Three rendering modes:
 *   <ReadinessBadge score={..} ready={..} compact />   small chip
 *   <ReadinessBar score={..} ready={..} />             score bar + label
 *   <ReadinessIssuesList issues={..} />                grouped error/warning list
 *
 * Color bands per spec:
 *   green   90..100
 *   yellow  70..89
 *   red     0..69
 */

import { useEffect, useState } from 'react';
import type { ReadinessIssue, ReadinessResult, MarketplaceTarget } from '@/lib/readiness';

// ─── Color helpers ───────────────────────────────────────────────────────────

function scoreColor(score: number): { bg: string; bar: string; text: string; label: string } {
  if (score >= 90) {
    return { bg: 'bg-green-600', bar: 'bg-green-600', text: 'text-green-700', label: 'Ready' };
  }
  if (score >= 70) {
    return { bg: 'bg-yellow-500', bar: 'bg-yellow-500', text: 'text-yellow-700', label: 'Warning' };
  }
  return { bg: 'bg-red-600', bar: 'bg-red-600', text: 'text-red-700', label: 'Error' };
}

// ─── Small chip badge — fits inside a card corner ────────────────────────────

export function ReadinessBadge({
  score,
  ready,
  compact = false,
  target,
}: {
  score: number;
  ready: boolean;
  compact?: boolean;
  target?: MarketplaceTarget;
}) {
  const c = scoreColor(score);
  if (compact) {
    return (
      <span
        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${c.bg} text-white inline-flex items-center gap-1`}
        title={`Readiness ${Math.round(score)}%${target ? ` (${target})` : ''} — ${c.label}`}
      >
        {ready ? '✓' : score >= 70 ? '⚠' : '✗'} {Math.round(score)}%
      </span>
    );
  }
  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded-md ${c.bg} text-white inline-flex items-center gap-1.5`}
    >
      {ready ? '✓ Ready' : c.label} · {Math.round(score)}%
      {target && <span className="opacity-80 text-[10px] uppercase ml-1">{target}</span>}
    </span>
  );
}

// ─── Full score bar with label — for edit pages and side panels ──────────────

export function ReadinessBar({
  score,
  ready,
  target,
  error_count = 0,
  warning_count = 0,
}: {
  score: number;
  ready: boolean;
  target?: MarketplaceTarget;
  error_count?: number;
  warning_count?: number;
}) {
  const c = scoreColor(score);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {target ? `${target} readiness` : 'Marketplace readiness'}
          </span>
          {error_count > 0 && (
            <span className="text-[11px] text-destructive">{error_count} error{error_count !== 1 && 's'}</span>
          )}
          {warning_count > 0 && (
            <span className="text-[11px] text-yellow-700">{warning_count} warning{warning_count !== 1 && 's'}</span>
          )}
        </div>
        <span className={`text-sm font-semibold ${c.text}`}>
          {Math.round(score)}% · {ready ? 'Ready' : c.label}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full transition-all ${c.bar}`}
          style={{ width: `${Math.max(2, Math.round(score))}%` }}
        />
      </div>
    </div>
  );
}

// ─── Grouped issue list — used in side panels ────────────────────────────────

export function ReadinessIssuesList({ issues }: { issues: ReadinessIssue[] }) {
  if (issues.length === 0) {
    return (
      <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">
        ✓ All readiness checks passed.
      </div>
    );
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return (
    <div className="space-y-2 text-sm">
      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
          <div className="text-xs font-semibold text-destructive uppercase tracking-wide mb-1.5">
            {errors.length} error{errors.length !== 1 && 's'} blocking publish
          </div>
          <ul className="space-y-1">
            {errors.map((i) => (
              <li key={i.code} className="text-destructive flex items-start gap-1.5">
                <span className="text-xs mt-0.5">✗</span>
                <span>
                  {i.message}
                  <span className="ml-1 text-[10px] font-mono text-muted-foreground">−{i.deduct}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-2.5">
          <div className="text-xs font-semibold text-yellow-700 uppercase tracking-wide mb-1.5">
            {warnings.length} warning{warnings.length !== 1 && 's'}
          </div>
          <ul className="space-y-1">
            {warnings.map((i) => (
              <li key={i.code} className="text-yellow-800 flex items-start gap-1.5">
                <span className="text-xs mt-0.5">⚠</span>
                <span>
                  {i.message}
                  <span className="ml-1 text-[10px] font-mono text-muted-foreground">−{i.deduct}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Hook: live-fetch readiness for a SKU + target ───────────────────────────

export function useReadiness(master_sku: string | null | undefined, target: MarketplaceTarget) {
  const [data, setData] = useState<ReadinessResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!master_sku) return;
    let cancel = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/products/${master_sku}/readiness?target=${target}`);
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (!cancel) setData(body.data);
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : 'Failed');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [master_sku, target]);

  return { data, loading, error };
}
