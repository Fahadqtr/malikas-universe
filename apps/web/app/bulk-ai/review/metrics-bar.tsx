'use client';

import { Card } from '@/components/ui';

export type Metrics = {
  total_drafts: number;
  pending_review: number;
  approved_today: number;
  failed_ai: number;
  avg_confidence: number;
  cost_today_usd: number;
  cost_total_usd: number;
  processed_today: number;
};

export function MetricsBar({ metrics }: { metrics: Metrics | null }) {
  if (!metrics) {
    return (
      <Card className="!p-3">
        <div className="text-sm text-muted-foreground">Loading metrics…</div>
      </Card>
    );
  }

  const avgPct = Math.round(metrics.avg_confidence * 100);
  const avgColor =
    avgPct >= 90 ? 'text-green-700' : avgPct >= 75 ? 'text-yellow-600' : 'text-destructive';

  return (
    <Card className="!p-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
        <Metric label="Total drafts" value={metrics.total_drafts} />
        <Metric label="Pending review" value={metrics.pending_review} color="text-yellow-600" />
        <Metric label="Approved today" value={metrics.approved_today} color="text-green-700" />
        <Metric label="AI failed" value={metrics.failed_ai} color={metrics.failed_ai > 0 ? 'text-destructive' : 'text-muted-foreground'} />
        <Metric
          label="Avg confidence"
          value={`${avgPct}%`}
          color={avgColor}
        />
        <Metric
          label="AI cost today"
          value={fmtUsd(metrics.cost_today_usd)}
          sub={`${metrics.processed_today} runs`}
        />
        <Metric
          label="AI cost total"
          value={fmtUsd(metrics.cost_total_usd)}
        />
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: number | string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="leading-tight">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-xl font-semibold ${color ?? ''}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
