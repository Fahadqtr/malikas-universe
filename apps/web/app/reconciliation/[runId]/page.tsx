/**
 * /reconciliation/[runId] — Findings dashboard for one comparison run.
 *
 * Layout:
 *   Top: run summary (baseline → targets, total findings, status)
 *   Tabs: by finding_type with counts
 *   Table: paginated findings list with severity, baseline vs target values
 *
 * Phase 13A: read-only display. Phase 13C will add bulk resolution + corrected export.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { getActor } from '@/lib/actor';
import RunDashboard from './run-dashboard';

export const dynamic = 'force-dynamic';

type Params = { params: { runId: string } };

export default async function RunPage({ params }: Params) {
  await getActor();
  const runId = Number(params.runId);
  if (!Number.isInteger(runId) || runId <= 0) notFound();

  const admin = createAdminSupabaseClient();
  const { data: run } = await admin
    .from('reconciliation_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle();
  if (!run) notFound();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <header>
          <Link href="/reconciliation" className="text-sm text-muted-foreground hover:text-foreground">
            ← Reconciliation
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            Run #{runId}
            {run.label && <span className="text-muted-foreground font-normal ml-2">— {run.label}</span>}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="capitalize">{run.baseline_platform}</span> →{' '}
            <span className="capitalize">{(run.target_platforms ?? []).join(', ')}</span>
          </p>
        </header>

        <RunDashboard
          runId={runId}
          initialRun={{
            ...run,
            findings_by_type: (run.findings_by_type ?? {}) as Record<string, number>,
          }}
        />
      </div>
    </main>
  );
}
