/**
 * /reconciliation/imports/[id] — Import preview & category review.
 *
 * Phase 13B.18: per-row category review. Operator can:
 *   - Filter by missing / source / category / search
 *   - Edit a single row's category via dropdown
 *   - Bulk-select rows and apply one category
 *   - "Auto-infer missing" — re-runs the extractor on category_missing rows
 *   - "Re-extract all" — rebuilds categories for every row (dangerous)
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import ImportPreviewClient from './preview-client';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

export default async function ImportPreviewPage({ params }: Params) {
  await getActor();
  const importId = Number(params.id);
  if (!Number.isInteger(importId) || importId <= 0) notFound();

  const admin = createAdminSupabaseClient();
  const { data: imp } = await admin
    .from('platform_imports')
    .select('*')
    .eq('id', importId)
    .maybeSingle();
  if (!imp) notFound();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <header>
          <Link href="/reconciliation" className="text-sm text-muted-foreground hover:text-foreground">
            ← Reconciliation
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            Import #{importId} —{' '}
            <span className="capitalize">{imp.platform}</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {imp.label ?? imp.source_filename ?? 'Untitled import'} ·{' '}
            <span className="tabular-nums">{imp.parsed_rows}</span> rows
          </p>
        </header>

        <ImportPreviewClient importId={importId} />
      </div>
    </main>
  );
}
