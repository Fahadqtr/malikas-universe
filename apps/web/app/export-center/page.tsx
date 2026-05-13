/**
 * /export-center — Marketplace Export Automation.
 *
 * Workflow:
 *   1. Choose target marketplace (Snoonu / Talabat / Rafeeq / Shopify CSV)
 *   2. Choose filters (all approved, by brand, by category, by selection)
 *   3. Preview → see eligible_count + blocked_count + reasons
 *   4. Fix blocked products OR generate CSV/XLSX of eligible only
 *   5. Download
 *   6. See history sidebar
 *
 * Hard rules from spec:
 *   ✗ Only active (approved) products
 *   ✗ Block products with missing required fields, show reasons
 *   ✓ Arabic + English preserved (UTF-8 BOM in CSV)
 *   ✓ Include SKU, barcode, price, category, brand, image_url
 *   ✓ Every export logged
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { ExportBuilder } from './export-builder';

export const dynamic = 'force-dynamic';

export default async function ExportCenterPage({
  searchParams,
}: {
  searchParams: { skus?: string; target?: string };
}) {
  await getActor();

  const admin = createAdminSupabaseClient();
  const [brandsRes, catsRes] = await Promise.all([
    admin.from('brands').select('id, name').eq('is_active', true).order('name'),
    admin.from('categories').select('id, name, code').order('display_order'),
  ]);

  // ?skus=MK-SKIN-0001,MK-MAKEUP-0002 → comes from Review Dashboard bulk action
  const presetSkus = searchParams.skus
    ? searchParams.skus.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const presetTarget =
    searchParams.target && ['snoonu', 'talabat', 'rafeeq', 'shopify'].includes(searchParams.target)
      ? (searchParams.target as 'snoonu' | 'talabat' | 'rafeeq' | 'shopify')
      : 'snoonu';

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-[1400px] mx-auto p-4 md:p-6 space-y-4">
        <header>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground">Home</Link>
            <span>›</span>
            <span>Export Center</span>
          </div>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">Export Center</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Generate marketplace-ready files for Snoonu, Talabat, Rafeeq, or Shopify.
            Only <strong className="text-foreground">approved</strong> products are exported.
            Products with missing required fields are blocked — fix them on the product page first.
          </p>
        </header>

        <ExportBuilder
          brands={brandsRes.data ?? []}
          categories={catsRes.data ?? []}
          presetSkus={presetSkus}
          presetTarget={presetTarget}
        />
      </div>
    </main>
  );
}
