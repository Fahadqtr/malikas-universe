/**
 * /products/new — Product creation page.
 * Server component loads brands + categories, then renders client form.
 */
import Link from 'next/link';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { ProductCreateForm } from './create-form';

export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  await getActor();
  const admin = createAdminSupabaseClient();

  const [brandsRes, catsRes, subcatsRes] = await Promise.all([
    admin.from('brands').select('id, name').eq('is_active', true).order('name'),
    admin.from('categories').select('id, name, code').order('display_order'),
    admin.from('subcategories').select('id, category_id, name').eq('is_active', true).order('display_order'),
  ]);

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <div>
          <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to products
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">New product</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Master SKU is auto-generated. You can upload images after creation.
          </p>
        </div>

        <ProductCreateForm
          brands={brandsRes.data ?? []}
          categories={catsRes.data ?? []}
          subcategories={subcatsRes.data ?? []}
        />
      </div>
    </main>
  );
}
