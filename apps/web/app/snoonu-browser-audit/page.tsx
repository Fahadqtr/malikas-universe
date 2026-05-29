/**
 * /snoonu-browser-audit — Phase 13E.5.
 *
 * READ-ONLY browser audit cockpit. Operator audits Snoonu products by
 * navigating to each product detail page in Chrome (read-only), then pasting
 * or pushing the snapshot into our app so we can save the EXACT Snoonu data.
 *
 * SAFETY:
 *   - This page only writes to our local DB.
 *   - It never POSTs anything back to Snoonu.
 *   - The "Open in Snoonu" button is a passive new-tab open. We do not script
 *     clicks/keystrokes on the Snoonu page from here.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import AuditClient from './audit-client';

export const dynamic = 'force-dynamic';

export default async function SnoonuBrowserAuditPage() {
  await getActor();
  const admin = createAdminSupabaseClient();

  const { data: imports } = await admin
    .from('platform_imports')
    .select('id, label, source_filename, parsed_rows, created_at')
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
          <h1 className="text-2xl font-semibold tracking-tight mt-1">Snoonu Browser Audit</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Capture the EXACT Snoonu data for products that need review (missing
            catalog, low confidence, possible match, price mismatch, or options).
          </p>
        </header>

        {/* Safety banner */}
        <div className="rounded-lg border-2 border-red-300 bg-red-50 px-4 py-3 text-sm">
          <div className="font-semibold text-red-900">⚠ READ-ONLY MODE</div>
          <div className="text-red-800 mt-1">
            Do <strong>not</strong> click Save, Submit, Publish, or Apply on the Snoonu page. This audit
            only reads what you can see. All changes happen in OUR system, never in Snoonu.
          </div>
        </div>

        <AuditClient
          imports={(imports ?? []) as Array<{
            id: number;
            label: string | null;
            source_filename: string | null;
            parsed_rows: number;
            created_at: string;
          }>}
        />
      </div>
    </main>
  );
}
