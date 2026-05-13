/**
 * /export — download CSV exports for each platform.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

const PLATFORMS = [
  {
    key: 'snoonu',
    name: 'Snoonu',
    description: 'Item Name English/Arabic, Brand, Category, Price, Stock, Image URL',
    color: 'bg-orange-500',
  },
  {
    key: 'shopify',
    name: 'Shopify',
    description: 'Handle, Title, Variant SKU/Price/Inventory, Image Src, Status — Shopify Admin import format',
    color: 'bg-emerald-500',
  },
  {
    key: 'talabat',
    name: 'Talabat',
    description: 'SKU, English/Arabic name, Category, Price, Quantity, Image, Description',
    color: 'bg-yellow-500',
  },
  {
    key: 'rafeeq',
    name: 'Rafeeq',
    description: 'SKU, Name EN/AR, Category, Brand, Price, Stock, Image, Barcode, Descriptions',
    color: 'bg-blue-500',
  },
  {
    key: 'master',
    name: 'Master',
    description: 'All fields in our internal schema — full snapshot for backup or analysis',
    color: 'bg-slate-500',
  },
];

export default async function ExportPage() {
  await getActor();
  const admin = createAdminSupabaseClient();
  const { count } = await admin
    .from('products')
    .select('id', { count: 'exact', head: true })
    .is('deleted_at', null)
    .eq('product_status', 'active');

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-8 space-y-6">
        <header>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">← Home</Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">Platform Exports</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {count ?? 0} active products will be included by default. Use the status selector to change.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PLATFORMS.map((p) => (
            <Card key={p.key}>
              <div className="flex items-start gap-3">
                <div className={`w-2 h-12 rounded ${p.color}`} />
                <div className="flex-1">
                  <h3 className="text-lg font-medium">{p.name}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{p.description}</p>

                  <div className="mt-4 flex gap-2 items-end">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Product status
                      </label>
                      <select
                        id={`status-${p.key}`}
                        defaultValue="active"
                        className="w-full px-3 py-1.5 text-sm border border-input bg-background rounded-md"
                      >
                        <option value="active">Active only</option>
                        <option value="draft">Draft only</option>
                        <option value="all">All (incl. archived)</option>
                      </select>
                    </div>
                    <a
                      href={`/api/export/${p.key}?status=active`}
                      id={`link-${p.key}`}
                      className="bg-primary text-primary-foreground rounded-md px-4 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity inline-block"
                    >
                      Download CSV
                    </a>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <Card className="!p-4 bg-muted/30">
          <p className="text-xs text-muted-foreground">
            <strong>Tip:</strong> Right-click the Download link → Save Link As to choose where the file goes. Or just click — it
            downloads to your default Downloads folder. UTF-8 BOM is included so Excel reads Arabic correctly.
          </p>
        </Card>
      </div>
    </main>
  );
}
