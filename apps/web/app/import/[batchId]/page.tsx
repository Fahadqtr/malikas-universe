/**
 * /import/[batchId] — review staged rows + commit
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { Card, Badge } from '@/components/ui';
import { ImportReviewActions } from './review-actions';

export const dynamic = 'force-dynamic';

export default async function ImportReviewPage({ params }: { params: { batchId: string } }) {
  await getActor();
  const id = parseInt(params.batchId, 10);
  if (!Number.isFinite(id)) notFound();

  const admin = createAdminSupabaseClient();
  const [batchRes, rowsRes] = await Promise.all([
    admin.from('import_batches').select('*').eq('id', id).single(),
    admin.from('import_errors').select('*').eq('batch_id', id).order('row_number'),
  ]);

  if (batchRes.error || !batchRes.data) notFound();
  const batch = batchRes.data;
  const rows = rowsRes.data ?? [];

  // Bucket counts
  const counts = rows.reduce(
    (acc, r) => {
      const t = (r.error_type as string) ?? 'unknown';
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-8 space-y-6">
        <header>
          <Link href="/import" className="text-sm text-muted-foreground hover:text-foreground">
            ← Imports
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">Review import #{batch.id}</h1>
          <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
            <span className="truncate max-w-xs">{batch.filename}</span>
            <span>·</span>
            <Badge variant="muted">{batch.source_platform ?? 'auto'}</Badge>
            <span>·</span>
            <Badge variant={batch.status === 'completed' ? 'success' : 'warning'}>{batch.status}</Badge>
          </div>
        </header>

        <Card>
          <h2 className="text-lg font-medium mb-3">Summary</h2>
          <div className="grid grid-cols-4 gap-4">
            <Stat label="Total rows" value={batch.total_rows ?? 0} />
            <Stat label="Auto-import" value={counts.auto_import ?? 0} color="text-green-700" />
            <Stat label="Review needed" value={counts.review_required ?? 0} color="text-yellow-700" />
            <Stat label="Blocked" value={counts.block ?? 0} color="text-destructive" />
          </div>
        </Card>

        <ImportReviewActions batchId={batch.id} status={batch.status} hasRows={rows.length > 0} />

        <Card className="!p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
            <h2 className="text-lg font-medium">Staged rows ({rows.length})</h2>
            <span className="text-xs text-muted-foreground">First 100 shown</span>
          </div>
          {rows.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No rows staged.</div>
          ) : (
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border sticky top-0">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">#</th>
                    <th className="text-left font-medium px-3 py-2">Decision</th>
                    <th className="text-left font-medium px-3 py-2">Reason</th>
                    <th className="text-left font-medium px-3 py-2">Name</th>
                    <th className="text-left font-medium px-3 py-2">Brand</th>
                    <th className="text-left font-medium px-3 py-2">Category</th>
                    <th className="text-left font-medium px-3 py-2">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 100).map((r) => {
                    const staged = (r.raw_data as Record<string, unknown>) ?? {};
                    const cleaned = (staged.cleaned as Record<string, unknown>) ?? {};
                    const cat = (staged.category as Record<string, unknown>) ?? {};
                    return (
                      <tr key={r.id} className="border-b border-border">
                        <td className="px-3 py-2 font-mono text-xs">{r.row_number}</td>
                        <td className="px-3 py-2">
                          <Badge variant={decisionVariant(r.error_type ?? '')}>{r.error_type}</Badge>
                        </td>
                        <td className="px-3 py-2 text-xs">{r.error_message}</td>
                        <td className="px-3 py-2 max-w-xs truncate">
                          {String(cleaned.product_name_en ?? '—')}
                        </td>
                        <td className="px-3 py-2 text-xs">{String(cleaned.brand_raw ?? '—')}</td>
                        <td className="px-3 py-2 text-xs">{String(cat.category_name ?? '—')}</td>
                        <td className="px-3 py-2 text-xs">
                          {cleaned.price != null ? `${cleaned.price}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold ${color ?? ''}`}>{value}</div>
    </div>
  );
}

function decisionVariant(d: string): 'success' | 'warning' | 'destructive' | 'muted' {
  if (d === 'auto_import') return 'success';
  if (d === 'review_required') return 'warning';
  if (d === 'block') return 'destructive';
  return 'muted';
}
