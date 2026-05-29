/**
 * /snoonu-catalog-mapper — Phase 13D.
 *
 * READ-ONLY catalog mapper for Snoonu. Captures where each product lives
 * inside Snoonu's catalog hierarchy (catalog → category → subcategory → section
 * → collection) without ever writing back to Snoonu itself.
 *
 * Server shell + client component.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import CatalogMapperClient from './catalog-mapper-client';

export const dynamic = 'force-dynamic';

export default async function SnoonuCatalogMapperPage() {
  await getActor();
  const admin = createAdminSupabaseClient();

  // Load every Snoonu import so the operator can pick which one to map
  const { data: imports } = await admin
    .from('platform_imports')
    .select('id, label, source_filename, parsed_rows, status, created_at')
    .eq('platform', 'snoonu')
    .order('created_at', { ascending: false })
    .limit(20);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <header>
          <Link href="/reconciliation" className="text-sm text-muted-foreground hover:text-foreground">
            ← Reconciliation
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">Snoonu Catalog Mapper</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Capture where each Snoonu product lives in the catalog hierarchy:
            catalog → category → subcategory → section → collection. Snoonu is the source of truth.
            <strong className="text-foreground"> Read-only — never writes to Snoonu.</strong>
          </p>
        </header>

        <CatalogMapperClient
          imports={(imports ?? []) as Array<{
            id: number;
            label: string | null;
            source_filename: string | null;
            parsed_rows: number;
            status: string;
            created_at: string;
          }>}
        />
      </div>
    </main>
  );
}
