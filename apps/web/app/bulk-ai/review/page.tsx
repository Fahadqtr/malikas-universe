/**
 * /bulk-ai/review — Catalog operating dashboard.
 *
 * The central command center for the Malika catalog team:
 *   • Review every AI-generated draft
 *   • Filter by ready / needs_review / failed / approved
 *   • Inline edit names, brand, category, keywords
 *   • Bulk approve / reject / retry / export
 *   • Keyboard shortcuts: A = approve, R = reject, E = edit
 *   • Side-by-side: AI suggestion vs final product fields
 *   • Marketplace Ready badge gates Shopify push
 *
 * Architecture is ready for Phase 8:
 *   • Push to Shopify button is a stub — will call /api/shopify/push when wired
 *   • Retry AI calls /api/bulk-ai/process with the same image — reusable from workers
 *   • Image upload column accepts new images and re-runs Claude vision
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { ReviewDashboard } from './review-dashboard';

export const dynamic = 'force-dynamic';

export default async function BulkAIReviewPage() {
  await getActor();

  // Load reference data (brands + categories) for inline edit dropdowns.
  // Cached at server-render — small datasets (<100 rows each).
  const admin = createAdminSupabaseClient();
  const [{ data: brands }, { data: categories }] = await Promise.all([
    admin.from('brands').select('id, name, code').order('name'),
    admin.from('categories').select('id, name, code').order('display_order'),
  ]);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto p-4 md:p-6 space-y-4">
        <header className="flex items-baseline justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Link href="/" className="hover:text-foreground">Home</Link>
              <span>›</span>
              <Link href="/bulk-ai" className="hover:text-foreground">Bulk AI</Link>
              <span>›</span>
              <span>Review</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-tight mt-1">Review Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Approve, edit, or reject AI-generated drafts. Shortcuts:
              <kbd className="ml-2 px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">A</kbd> approve
              <kbd className="ml-1 px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">R</kbd> reject
              <kbd className="ml-1 px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">E</kbd> edit
              <kbd className="ml-1 px-1.5 py-0.5 text-[10px] font-mono bg-muted rounded">G/T</kbd> grid/table
            </p>
          </div>
        </header>

        <ReviewDashboard
          brands={brands ?? []}
          categories={categories ?? []}
        />
      </div>
    </main>
  );
}
