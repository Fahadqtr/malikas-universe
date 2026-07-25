/**
 * /products — Product list dashboard.
 * Server component. Fetches via ProductsService (RLS-respecting).
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';
import { Button, Card, ProductStatusBadge, StockStatusBadge } from '@/components/ui';
import { ReadinessBadge } from '@/components/readiness-badge';
import { checkReadiness, type ProductForReadiness } from '@/lib/readiness';

export const dynamic = 'force-dynamic';

type SearchParams = {
  q?: string;
  status?: string;
  category_id?: string;
  page?: string;
};

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await getActor();
  const { products, categories } = getServices(actor);

  const pageNum = Number(searchParams.page ?? 1);
  const list = await products.list({
    page: pageNum,
    page_size: 25,
    q: searchParams.q || undefined,
    status: (searchParams.status as never) || undefined,
    category_id: searchParams.category_id ? Number(searchParams.category_id) : undefined,
    sort: 'updated_at_desc',
    include_deleted: false,
  });

  const mainCategories = await categories.listMain();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-8 space-y-6">
        {/* Header */}
        <header className="flex items-center justify-between">
          <div>
            <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
              ← Home
            </Link>
            <h1 className="text-3xl font-semibold tracking-tight mt-1">Products</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {list.total} total · page {list.page} of {Math.max(1, Math.ceil(list.total / list.page_size))}
            </p>
          </div>
          <Link href="/products/new">
            <Button>+ New product</Button>
          </Link>
        </header>

        {/* Filter bar */}
        <Card className="!p-4">
          <form method="get" className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-muted-foreground mb-1">Search</label>
              <input
                type="text"
                name="q"
                defaultValue={searchParams.q ?? ''}
                placeholder="Name, SKU, barcode..."
                className="w-full px-3 py-2 text-sm border border-input bg-background rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Status</label>
              <select
                name="status"
                defaultValue={searchParams.status ?? ''}
                className="px-3 py-2 text-sm border border-input bg-background rounded-md"
              >
                <option value="">All</option>
                <option value="draft">Draft</option>
                <option value="pending_approval">Pending</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Category</label>
              <select
                name="category_id"
                defaultValue={searchParams.category_id ?? ''}
                className="px-3 py-2 text-sm border border-input bg-background rounded-md"
              >
                <option value="">All</option>
                {mainCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="secondary">Filter</Button>
            <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground self-center">
              Clear
            </Link>
          </form>
        </Card>

        {/* Table */}
        <Card className="!p-0 overflow-hidden">
          {list.items.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <p className="text-sm">No products found.</p>
              <Link href="/products/new" className="text-primary hover:underline mt-2 inline-block">
                Create the first one →
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th className="text-left font-medium px-4 py-3">SKU</th>
                    <th className="text-left font-medium px-4 py-3">Name</th>
                    <th className="text-left font-medium px-4 py-3">Price</th>
                    <th className="text-left font-medium px-4 py-3">Stock</th>
                    <th className="text-left font-medium px-4 py-3">Status</th>
                    <th className="text-left font-medium px-4 py-3">Readiness</th>
                    <th className="text-left font-medium px-4 py-3">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((p) => {
                    // Approximate readiness from list-view fields only.
                    // Some warnings (descriptions/keywords) may be missing here —
                    // exact score is computed on the edit page.
                    const r = checkReadiness(p as ProductForReadiness, 'shopify');
                    return (
                    <tr key={p.master_sku} className="border-b border-border hover:bg-muted/30">
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link href={`/products/${p.master_sku}`} className="text-primary hover:underline">
                          {p.master_sku}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{p.product_name_en}</div>
                        <div className="text-xs text-muted-foreground" dir="rtl">
                          {p.product_name_ar}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-medium">QAR {Number(p.price).toFixed(2)}</span>
                        {p.discount_price && (
                          <div className="text-xs text-green-700">QAR {Number(p.discount_price).toFixed(2)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          <span>{p.stock_quantity}</span>
                          <StockStatusBadge status={p.stock_status} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <ProductStatusBadge status={p.product_status} />
                      </td>
                      <td className="px-4 py-3">
                        <ReadinessBadge score={r.score} ready={r.ready} compact target="shopify" />
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(p.updated_at!).toLocaleDateString()}
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Pagination */}
        {list.total > list.page_size && (
          <div className="flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              Showing {(list.page - 1) * list.page_size + 1}–
              {Math.min(list.page * list.page_size, list.total)} of {list.total}
            </div>
            <div className="flex gap-2">
              {list.page > 1 && (
                <Link href={pageLink(searchParams, list.page - 1)}>
                  <Button variant="secondary" size="sm">← Prev</Button>
                </Link>
              )}
              {list.has_more && (
                <Link href={pageLink(searchParams, list.page + 1)}>
                  <Button variant="secondary" size="sm">Next →</Button>
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function pageLink(params: SearchParams, page: number): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set('q', params.q);
  if (params.status) sp.set('status', params.status);
  if (params.category_id) sp.set('category_id', params.category_id);
  sp.set('page', String(page));
  return `/products?${sp.toString()}`;
}
