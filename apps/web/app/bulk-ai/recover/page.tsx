/**
 * /bulk-ai/recover — Recovery Queue.
 *
 * Owner/editor review screen for AI outputs that were SAVED to `ai_drafts`
 * because product creation failed (schema cache, FK, etc.). Nothing here is
 * published automatically: each draft is converted into a real *draft* product
 * via the atomic POST /api/bulk-ai/recover, one at a time.
 *
 * Server Component: enforces ROLE_SETS.writers and loads small reference
 * datasets (brands / categories / subcategories) for the inline editor. All
 * reads/writes of drafts happen client-side through the API — never Supabase.
 */
import Link from 'next/link';
import { requireActor, ROLE_SETS } from '@/lib/authorization';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { RecoveryDashboard } from './recovery-dashboard';

export const dynamic = 'force-dynamic';

export default async function RecoveryQueuePage() {
  await requireActor(ROLE_SETS.writers);

  // Small reference datasets for the inline editor dropdowns (<200 rows each).
  const admin = createAdminSupabaseClient();
  const [{ data: brands }, { data: categories }, { data: subcategories }] = await Promise.all([
    admin.from('brands').select('id, name, code').order('name'),
    admin.from('categories').select('id, name, code').order('display_order'),
    admin.from('subcategories').select('id, name, category_id').order('name'),
  ]);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Home</Link>
            <span aria-hidden="true">›</span>
            <Link href="/bulk-ai" className="hover:text-foreground">Bulk AI</Link>
            <span aria-hidden="true">›</span>
            <span aria-current="page">Recovery Queue</span>
          </nav>
          <h1 className="text-3xl font-semibold tracking-tight">Recovery Queue</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            These are AI outputs that were <strong className="text-foreground">saved</strong> when product
            creation failed — nothing was lost. Review each one, adjust the fields if needed, and recover it
            into a <strong className="text-foreground">draft product</strong>. Nothing publishes automatically.
          </p>
        </header>

        <RecoveryDashboard
          brands={brands ?? []}
          categories={categories ?? []}
          subcategories={subcategories ?? []}
        />
      </div>
    </main>
  );
}
