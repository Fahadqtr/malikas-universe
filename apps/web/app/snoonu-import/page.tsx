/**
 * /snoonu-import — Landing page for Snoonu product imports.
 *
 * Shows:
 *   - Recent batches (with status badges + counts)
 *   - "Start new import" button → links to /snoonu-import/new
 *
 * Phase 13.8.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { Button, Card, Badge } from '@/components/ui';

export const dynamic = 'force-dynamic';

type BatchRow = {
  id: number;
  label: string | null;
  source_mode: string;
  total_items: number;
  extracted_count: number;
  matched_count: number;
  variant_count: number;
  applied_count: number;
  blocked_count: number;
  image_failed_count: number;
  status: string;
  created_at: string;
  completed_at: string | null;
};

const STATUS_COLOR: Record<string, 'default' | 'success' | 'warning' | 'destructive' | 'muted'> = {
  pending: 'muted',
  extracting: 'warning',
  matching: 'warning',
  review_ready: 'default',
  applying: 'warning',
  applied: 'success',
  cancelled: 'muted',
  error: 'destructive',
};

const MODE_LABEL: Record<string, string> = {
  single_url: 'Single URL',
  category_url: 'Category page',
  paste_list: 'URL list',
  csv_upload: 'CSV upload',
  xlsx_upload: 'Excel upload',
  html_paste: 'HTML paste',
};

export default async function SnoonuImportLandingPage() {
  await getActor();
  const admin = createAdminSupabaseClient();

  const { data: batches } = await admin
    .from('snoonu_import_batches')
    .select(
      'id, label, source_mode, total_items, extracted_count, matched_count, variant_count, applied_count, blocked_count, image_failed_count, status, created_at, completed_at',
    )
    .order('created_at', { ascending: false })
    .limit(50);

  const rows = (batches ?? []) as BatchRow[];

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
              ← Home
            </Link>
            <h1 className="text-3xl font-semibold tracking-tight mt-1">Snoonu Import</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Pull products straight from Snoonu — images get renamed to SKU automatically, variants
              detected, duplicates matched. Review before anything writes to your catalog.
            </p>
          </div>
          <Link href="/snoonu-import/new">
            <Button>+ New import</Button>
          </Link>
        </header>

        {/* Quick stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Batches" value={rows.length} />
          <Stat label="Pending review" value={rows.filter((r) => r.status === 'review_ready').length} />
          <Stat label="Applied" value={rows.filter((r) => r.status === 'applied').length} />
          <Stat label="Errors" value={rows.filter((r) => r.status === 'error').length} />
        </div>

        {/* Batch table */}
        <Card className="!p-0 overflow-hidden">
          {rows.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <p className="text-sm">No Snoonu imports yet.</p>
              <Link href="/snoonu-import/new" className="text-primary hover:underline mt-2 inline-block">
                Start the first import →
              </Link>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Batch</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3 text-right">Items</th>
                  <th className="px-4 py-3 text-right">Extracted</th>
                  <th className="px-4 py-3 text-right">Matched</th>
                  <th className="px-4 py-3 text-right">Applied</th>
                  <th className="px-4 py-3 text-right">Issues</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="font-medium">#{b.id}</div>
                      <div className="text-xs text-muted-foreground">{b.label ?? '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{MODE_LABEL[b.source_mode] ?? b.source_mode}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.total_items}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.extracted_count}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.matched_count}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{b.applied_count}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {b.blocked_count + b.image_failed_count > 0 ? (
                        <span className="text-red-600">{b.blocked_count + b.image_failed_count}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_COLOR[b.status] ?? 'muted'}>
                        {b.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(b.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/snoonu-import/${b.id}/review`}
                        className="text-primary hover:underline text-xs font-medium"
                      >
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="bg-muted/30">
          <h3 className="font-medium mb-2">How it works</h3>
          <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
            <li>Drop a Snoonu URL (single, category, paste list, or CSV upload)</li>
            <li>System extracts name/price/image/SKU/barcode + detects variants</li>
            <li>Image is renamed to your SKU and saved to <code>products/{`{sku}`}/{`{SKU}`}.jpg</code></li>
            <li>Matcher checks if the product already exists in your catalog</li>
            <li>You review every item — approve, update, skip, or merge as variant</li>
            <li>Apply pushes only the approved items to <code>products</code></li>
          </ol>
        </Card>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{value}</div>
    </Card>
  );
}
