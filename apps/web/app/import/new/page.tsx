import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { UploadForm } from './upload-form';

export const dynamic = 'force-dynamic';

export default async function NewImportPage() {
  await getActor();
  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-8 space-y-6">
        <div>
          <Link href="/import" className="text-sm text-muted-foreground hover:text-foreground">
            ← Imports
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">New import</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Upload a Snoonu, Shopify, Talabat, or Rafeeq export (.xlsx / .csv). Max 5 MB.
          </p>
        </div>
        <UploadForm />
      </div>
    </main>
  );
}
