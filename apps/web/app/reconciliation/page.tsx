/**
 * /reconciliation — Phase 13A landing page.
 *
 * Layout:
 *   Top:   4 upload cards (Snoonu / Talabat / Rafeeq / Shopify)
 *   Mid:   Recent imports table
 *   Bot:   Start comparison panel (pick baseline + target → POST /runs)
 *          + Recent runs table
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui';
import ReconciliationClient from './reconciliation-client';

export const dynamic = 'force-dynamic';

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

export default async function ReconciliationLandingPage() {
  await getActor();
  const admin = createAdminSupabaseClient();

  const [importsRes, runsRes] = await Promise.all([
    admin
      .from('platform_imports')
      .select('id, platform, label, source_filename, total_rows, parsed_rows, matched_rows, unmatched_rows, status, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    admin
      .from('reconciliation_runs')
      .select('id, label, baseline_platform, target_platforms, findings_total, findings_by_type, status, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const imports = (importsRes.data ?? []) as ImportRow[];
  const runs = (runsRes.data ?? []) as RunRow[];

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-8 space-y-6">
        <header>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Home
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">Marketplace Reconciliation</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Snoonu is the source of truth. Upload an export from any platform, then compare against
            Snoonu to find missing products, price gaps, name/category mismatches, and duplicates.
          </p>
        </header>

        <ReconciliationClient initialImports={imports} initialRuns={runs} />

        {/* How it works */}
        <Card className="bg-muted/30">
          <h3 className="font-medium mb-2">How it works</h3>
          <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
            <li>Upload your Snoonu export — this becomes the baseline</li>
            <li>Upload Talabat / Rafeeq / Shopify / internal exports</li>
            <li>System auto-detects platform from column headers and normalizes the rows</li>
            <li>SKU and barcode matching against your master catalog happens on upload</li>
            <li>Start a comparison run: pick Snoonu as baseline + one or more targets</li>
            <li>Review findings: missing products, price mismatches, category drift, duplicates</li>
            <li>Future (13B / 13C): variant matching, image mismatch, corrected export generation</li>
          </ol>
        </Card>
      </div>
    </main>
  );
}
