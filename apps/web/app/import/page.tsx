/**
 * /import — list of import batches.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { Button, Card, Badge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ImportListPage() {
  await getActor();
  const admin = createAdminSupabaseClient();

  const { data: batches } = await admin
    .from('import_batches')
    .select('id, filename, source_platform, total_rows, success_rows, error_rows, status, started_at, completed_at, initiated_by, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">← Home</Link>
            <h1 className="text-3xl font-semibold tracking-tight mt-1">Bulk Import</h1>
            <p className="text-sm text-muted-foreground mt-1">Import products from Excel / CSV.</p>
          </div>
          <Link href="/import/new"><Button>+ New import</Button></Link>
        </header>

        <Card className="!p-0 overflow-hidden">
          {!batches?.length ? (
            <div className="p-12 text-center text-muted-foreground">
              <p className="text-sm">No imports yet.</p>
              <Link href="/import/new" className="text-primary hover:underline mt-2 inline-block">
                Start the first import →
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th className="text-left font-medium px-4 py-3">#</th>
                    <th className="text-left font-medium px-4 py-3">File</th>
                    <th className="text-left font-medium px-4 py-3">Platform</th>
                    <th className="text-left font-medium px-4 py-3">Rows</th>
                    <th className="text-left font-medium px-4 py-3">Status</th>
                    <th className="text-left font-medium px-4 py-3">Started</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} className="border-b border-border hover:bg-muted/30">
                      <td className="px-4 py-3 font-mono text-xs">{b.id}</td>
                      <td className="px-4 py-3 max-w-xs truncate" title={b.filename}>{b.filename}</td>
                      <td className="px-4 py-3"><Badge variant="muted">{b.source_platform ?? '—'}</Badge></td>
                      <td className="px-4 py-3 text-xs">
                        <span className="font-medium">{b.total_rows ?? 0}</span> total ·{' '}
                        <span className="text-green-700">{b.success_rows ?? 0}</span> ok ·{' '}
                        <span className="text-destructive">{b.error_rows ?? 0}</span> err
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={statusVariant(b.status)}>{b.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {b.created_at ? new Date(b.created_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/import/${b.id}`} className="text-primary hover:underline text-sm">
                          Review →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}

function statusVariant(status: string): 'success' | 'warning' | 'destructive' | 'muted' | 'default' {
  switch (status) {
    case 'completed': return 'success';
    case 'failed': return 'destructive';
    case 'rolled_back': return 'destructive';
    case 'validating':
    case 'importing': return 'warning';
    default: return 'muted';
  }
}
