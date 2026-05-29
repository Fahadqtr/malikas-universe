'use client';

import { Card } from '@/components/ui';

export type SupportMetrics = {
  active_chats: number;
  escalations: number;
  resolved_today: number;
  ai_handled_pct: number;
  human_handled_pct: number;
  ai_calls_7d: number;
  ai_errors_7d: number;
  ai_cost_7d: number;
  top_concerns: Array<{ tag: string; count: number }>;
};

export function MetricsBar({ metrics }: { metrics: SupportMetrics | null }) {
  if (!metrics) {
    return (
      <Card className="!p-3 text-sm text-muted-foreground">Loading metrics…</Card>
    );
  }
  return (
    <Card className="!p-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
        <Stat label="Active chats" value={metrics.active_chats} color="text-foreground" />
        <Stat label="Escalations" value={metrics.escalations} color={metrics.escalations > 0 ? 'text-destructive' : 'text-muted-foreground'} />
        <Stat label="Resolved today" value={metrics.resolved_today} color="text-green-700" />
        <Stat label="AI handled" value={`${metrics.ai_handled_pct}%`} color="text-blue-600" />
        <Stat label="Human handled" value={`${metrics.human_handled_pct}%`} color="text-purple-700" />
        <Stat label="AI calls (7d)" value={metrics.ai_calls_7d} sub={`${metrics.ai_errors_7d} errors`} />
        <Stat label="AI cost (7d)" value={`$${metrics.ai_cost_7d.toFixed(3)}`} />
      </div>
      {metrics.top_concerns.length > 0 && (
        <div className="mt-3 pt-2 border-t border-border flex flex-wrap gap-2 items-center">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Top concerns:</span>
          {metrics.top_concerns.map((c) => (
            <span
              key={c.tag}
              className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
            >
              {c.tag} <span className="font-semibold text-foreground">{c.count}</span>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: number | string;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="leading-tight">
      <div className="text-[10px] uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-xl font-semibold ${color ?? ''}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
