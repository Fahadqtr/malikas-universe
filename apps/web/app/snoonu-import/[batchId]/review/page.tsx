/**
 * /snoonu-import/[batchId]/review — Server-rendered shell.
 *
 * Loads the batch + first page of items server-side for fast first paint,
 * then hands off to the client component which polls /status and refreshes.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { getActor } from '@/lib/actor';
import ReviewClient from './review-client';

export const dynamic = 'force-dynamic';

type Params = { params: { batchId: string } };

export default async function ReviewPage({ params }: Params) {
  await getActor();
  const batchId = Number(params.batchId);
  if (!Number.isInteger(batchId) || batchId <= 0) notFound();

  const admin = createAdminSupabaseClient();

  const { data: batch } = await admin
    .from('snoonu_import_batches')
    .select('*')
    .eq('id', batchId)
    .maybeSingle();

  if (!batch) notFound();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <Link href="/snoonu-import" className="text-sm text-muted-foreground hover:text-foreground">
              ← Snoonu Import
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight mt-1">
              Batch #{batchId}
              {batch.label && <span className="text-muted-foreground font-normal ml-2">— {batch.label}</span>}
            </h1>
          </div>
        </header>

        <ReviewClient batchId={batchId} initialBatch={batch} />
      </div>
    </main>
  );
}
