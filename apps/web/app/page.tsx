/**
 * Home page — minimal landing for Phase 4 verification.
 * Phase 5 will replace this with the real dashboard.
 */
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server';
import { SignOutButton } from './sign-out-button';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let profile: { full_name: string | null; role: string; email: string } | null = null;
  let healthCheck = { categories: 0, brands: 0, products: 0, error: null as string | null };

  if (user) {
    const admin = createAdminSupabaseClient();

    const profileRes = await admin
      .from('user_profiles')
      .select('full_name, role, email')
      .eq('id', user.id)
      .single();
    profile = (profileRes.data as never) ?? null;

    const [catRes, brandRes, prodRes] = await Promise.all([
      admin.from('categories').select('id', { count: 'exact', head: true }),
      admin.from('brands').select('id', { count: 'exact', head: true }),
      admin.from('products').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    ]);

    healthCheck = {
      categories: catRes.count ?? 0,
      brands: brandRes.count ?? 0,
      products: prodRes.count ?? 0,
      error: catRes.error?.message ?? brandRes.error?.message ?? prodRes.error?.message ?? null,
    };
  }

  return (
    <main className="min-h-screen bg-background p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Malika&apos;s Universe</h1>
            <p className="text-sm text-muted-foreground mt-1">Admin platform — Phase 4 verification</p>
          </div>
          {user && <SignOutButton />}
        </header>

        {user && profile ? (
          <section className="bg-card border border-border rounded-lg p-6 space-y-2">
            <div className="text-sm text-muted-foreground">Signed in as</div>
            <div className="text-lg font-medium">{profile.full_name ?? profile.email}</div>
            <div className="inline-flex items-center text-xs uppercase tracking-wide bg-primary text-primary-foreground rounded-md px-2 py-1">
              {profile.role}
            </div>
          </section>
        ) : (
          <section className="bg-card border border-border rounded-lg p-6">
            <p className="text-sm text-muted-foreground">No `user_profiles` row found for your auth user.</p>
            <p className="text-sm mt-2">Open Supabase SQL Editor and run:</p>
            <pre className="text-xs bg-muted p-3 rounded-md mt-2 overflow-x-auto">
{`INSERT INTO user_profiles (id, email, full_name, role, is_active)
SELECT id, email, 'Fahad', 'owner', true
  FROM auth.users
 WHERE email = '${user?.email ?? 'YOUR_EMAIL'}';`}
            </pre>
          </section>
        )}

        <section className="bg-card border border-border rounded-lg p-6 space-y-3">
          <h2 className="text-lg font-medium">Database Connection</h2>
          {healthCheck.error ? (
            <p className="text-sm text-destructive">Error: {healthCheck.error}</p>
          ) : (
            <div className="grid grid-cols-3 gap-4">
              <Stat label="Categories" value={healthCheck.categories} expected={11} />
              <Stat label="Brands" value={healthCheck.brands} expected={22} />
              <Stat label="Products" value={healthCheck.products} expected={null} />
            </div>
          )}
        </section>

        <section className="bg-card border border-border rounded-lg p-6 space-y-3">
          <h2 className="text-lg font-medium">Admin</h2>
          <div className="grid grid-cols-2 gap-3">
            <a
              href="/products"
              className="block p-4 border border-border rounded-md hover:bg-muted/50 transition-colors"
            >
              <div className="font-medium">Products →</div>
              <div className="text-xs text-muted-foreground mt-0.5">Browse, create, edit catalog</div>
            </a>
            <a
              href="/products/new"
              className="block p-4 border border-border rounded-md hover:bg-muted/50 transition-colors"
            >
              <div className="font-medium">+ New product</div>
              <div className="text-xs text-muted-foreground mt-0.5">With AI autofill support</div>
            </a>
            <a
              href="/import"
              className="block p-4 border border-border rounded-md hover:bg-muted/50 transition-colors"
            >
              <div className="font-medium">Bulk Import →</div>
              <div className="text-xs text-muted-foreground mt-0.5">Upload Excel from Snoonu / Shopify / Talabat / Rafeeq</div>
            </a>
            <a
              href="/export"
              className="block p-4 border border-border rounded-md hover:bg-muted/50 transition-colors"
            >
              <div className="font-medium">Export →</div>
              <div className="text-xs text-muted-foreground mt-0.5">Download clean CSV for each platform</div>
            </a>
            <a
              href="/bulk-ai"
              className="block p-4 border border-border rounded-md hover:bg-muted/50 transition-colors col-span-2"
            >
              <div className="font-medium">Bulk AI Upload →</div>
              <div className="text-xs text-muted-foreground mt-0.5">Drop 100+ product images — AI auto-creates bilingual drafts (Phase 7)</div>
            </a>
          </div>
        </section>

        <section className="bg-card border border-border rounded-lg p-6 space-y-3">
          <h2 className="text-lg font-medium">API endpoints</h2>
          <ul className="text-sm space-y-1 text-muted-foreground">
            <li>
              <a href="/api/health" className="text-primary hover:underline">/api/health</a> — system status
            </li>
            <li>
              <a href="/api/products" className="text-primary hover:underline">/api/products</a> — list products
            </li>
            <li>
              <a href="/api/categories" className="text-primary hover:underline">/api/categories</a> — categories
            </li>
            <li>
              <a href="/api/brands" className="text-primary hover:underline">/api/brands</a> — brands
            </li>
            <li>
              <a href="/api/issues" className="text-primary hover:underline">/api/issues</a> — validation issues
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value, expected }: { label: string; value: number; expected: number | null }) {
  const ok = expected == null || value >= expected;
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold ${ok ? '' : 'text-destructive'}`}>{value}</div>
      {expected != null && (
        <div className="text-xs text-muted-foreground">expected: {expected}</div>
      )}
    </div>
  );
}
