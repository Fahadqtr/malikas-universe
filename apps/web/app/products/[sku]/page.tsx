/**
 * /products/[sku] — Edit a single product.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { Button, Card, ProductStatusBadge } from '@/components/ui';
import { ProductEditForm } from './edit-form';
import { ImageUploader } from './image-uploader';
import { ReadinessPanel } from './readiness-panel';

export const dynamic = 'force-dynamic';

export default async function EditProductPage({ params }: { params: { sku: string } }) {
  const actor = await getActor();
  const { products, issues } = getServices(actor);

  let product;
  try {
    product = await products.findBySku(params.sku);
  } catch {
    notFound();
  }

  const admin = createAdminSupabaseClient();
  const [brandsRes, catsRes, subcatsRes, imagesRes, issuesRes] = await Promise.all([
    admin.from('brands').select('id, name').eq('is_active', true).order('name'),
    admin.from('categories').select('id, name, code').order('display_order'),
    admin.from('subcategories').select('id, category_id, name').eq('is_active', true).order('display_order'),
    admin
      .from('product_images')
      .select('id, cdn_url, filename, is_primary, format, file_size_kb, uploaded_at')
      .eq('master_sku', params.sku)
      .order('is_primary', { ascending: false }),
    admin
      .from('validation_issues')
      .select('id, rule_id, severity, field_name, message, status, created_at')
      .eq('master_sku', params.sku)
      .eq('status', 'open'),
  ]);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto p-8 space-y-6">
        {/* Header */}
        <header>
          <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground">
            ← Products
          </Link>
          <div className="flex items-start justify-between mt-1">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{product.product_name_en}</h1>
              <p className="text-sm font-mono text-muted-foreground mt-1">{product.master_sku}</p>
              <div className="mt-2">
                <ProductStatusBadge status={product.product_status} />
              </div>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main form */}
          <div className="lg:col-span-2 space-y-6">
            <ProductEditForm
              product={product as never}
              brands={brandsRes.data ?? []}
              categories={catsRes.data ?? []}
              subcategories={subcatsRes.data ?? []}
            />
          </div>

          {/* Sidebar: images + issues */}
          <div className="space-y-6">
            <Card>
              <h2 className="text-lg font-medium mb-3">Images</h2>
              <ImageUploader
                masterSku={product.master_sku}
                initialImages={(imagesRes.data ?? []).map((row) => ({
                  ...row,
                  is_primary: row.is_primary ?? false,
                  uploaded_at: row.uploaded_at ?? '',
                }))}
              />
            </Card>

            <Card>
              <h2 className="text-lg font-medium mb-3">Validation Issues</h2>
              {(issuesRes.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No open issues.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {(issuesRes.data ?? []).map((issue) => (
                    <li
                      key={issue.id}
                      className={`p-2 rounded-md border ${
                        issue.severity === 'critical'
                          ? 'border-destructive/40 bg-destructive/10'
                          : issue.severity === 'high'
                            ? 'border-yellow-500/40 bg-yellow-500/10'
                            : 'border-border bg-muted/30'
                      }`}
                    >
                      <div className="font-medium">
                        {issue.rule_id} · {issue.severity}
                      </div>
                      <div className="text-xs text-muted-foreground">{issue.field_name}</div>
                      <div className="mt-0.5">{issue.message}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <h2 className="text-lg font-medium mb-3">Marketplace Readiness</h2>
              <ReadinessPanel
                product={{
                  master_sku: product.master_sku,
                  product_name_en: product.product_name_en,
                  product_name_ar: product.product_name_ar,
                  brand_id: product.brand_id,
                  category_id: product.category_id,
                  subcategory_id: product.subcategory_id,
                  barcode: product.barcode,
                  price: typeof product.price === 'number' ? product.price : Number(product.price ?? 0),
                  stock_quantity: product.stock_quantity,
                  product_status: product.product_status,
                  image_url: product.image_url,
                  description_en: product.description_en,
                  description_ar: product.description_ar,
                  usage_en: product.usage_en,
                  usage_ar: product.usage_ar,
                  keywords_en: product.keywords_en,
                  keywords_ar: product.keywords_ar,
                }}
              />
            </Card>

            <Card>
              <h2 className="text-lg font-medium mb-3">Actions</h2>
              <div className="space-y-2">
                <form action={`/api/products/${product.master_sku}/approve`} method="post">
                  <Button type="submit" variant="secondary" className="w-full">
                    Approve → Active
                  </Button>
                </form>
                <Link href={`/products/${product.master_sku}/history`} className="block">
                  <Button variant="ghost" className="w-full">View history</Button>
                </Link>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
