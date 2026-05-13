'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { AIAutofillButton, type ApplyValues } from '@/components/ai-autofill-modal';

type Brand = { id: number; name: string };
type Category = { id: number; name: string; code: string };
type Subcategory = { id: number; category_id: number; name: string };

type Product = {
  master_sku: string;
  product_name_en: string;
  product_name_ar: string;
  brand_id: number;
  category_id: number;
  subcategory_id: number | null;
  product_type: string | null;
  size: string | null;
  color: string | null;
  variant: string | null;
  price: number;
  discount_price: number | null;
  cost: number | null;
  stock_quantity: number;
  barcode: string | null;
  snoonu_sku: string | null;
  description_en: string | null;
  description_ar: string | null;
  usage_en: string | null;
  usage_ar: string | null;
  keywords_en: string[] | null;
  keywords_ar: string[] | null;
  product_status: string;
  image_url: string | null;
};

export function ProductEditForm({
  product,
  brands,
  categories,
  subcategories,
}: {
  product: Product;
  brands: Brand[];
  categories: Category[];
  subcategories: Subcategory[];
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState({
    product_name_en: product.product_name_en,
    product_name_ar: product.product_name_ar,
    brand_id: String(product.brand_id),
    category_id: String(product.category_id),
    subcategory_id: product.subcategory_id ? String(product.subcategory_id) : '',
    product_type: product.product_type ?? '',
    size: product.size ?? '',
    color: product.color ?? '',
    variant: product.variant ?? '',
    price: String(product.price),
    discount_price: product.discount_price != null ? String(product.discount_price) : '',
    cost: product.cost != null ? String(product.cost) : '',
    stock_quantity: String(product.stock_quantity),
    barcode: product.barcode ?? '',
    snoonu_sku: product.snoonu_sku ?? '',
    description_en: product.description_en ?? '',
    description_ar: product.description_ar ?? '',
    usage_en: product.usage_en ?? '',
    usage_ar: product.usage_ar ?? '',
    keywords_en: (product.keywords_en ?? []).join(', '),
    keywords_ar: (product.keywords_ar ?? []).join('، '),
    product_status: product.product_status,
  });
  const [genBarcode, setGenBarcode] = useState(false);

  const availableSubcategories = useMemo(
    () => subcategories.filter((s) => s.category_id === Number(form.category_id)),
    [form.category_id, subcategories],
  );

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSuccess(null);
  }

  function applyAI(values: ApplyValues) {
    setForm((f) => {
      const next = { ...f };
      if (typeof values.product_name_en === 'string') next.product_name_en = values.product_name_en;
      if (typeof values.product_name_ar === 'string') next.product_name_ar = values.product_name_ar;
      if (typeof values.brand_id === 'number') next.brand_id = String(values.brand_id);
      if (typeof values.category_id === 'number') {
        next.category_id = String(values.category_id);
        next.subcategory_id = '';
      }
      if (typeof values.subcategory_id === 'number') next.subcategory_id = String(values.subcategory_id);
      if (typeof values.product_type === 'string') next.product_type = values.product_type;
      if (typeof values.size === 'string') next.size = values.size;
      if (typeof values.variant === 'string') next.variant = values.variant;
      if (typeof values.color === 'string') next.color = values.color;
      if (typeof values.description_en === 'string') next.description_en = values.description_en;
      if (typeof values.description_ar === 'string') next.description_ar = values.description_ar;
      if (typeof values.usage_en === 'string') next.usage_en = values.usage_en;
      if (typeof values.usage_ar === 'string') next.usage_ar = values.usage_ar;
      if (Array.isArray(values.keywords_en)) next.keywords_en = values.keywords_en.join(', ');
      if (Array.isArray(values.keywords_ar)) next.keywords_ar = values.keywords_ar.join('، ');
      return next;
    });
    setSuccess(null);
  }

  async function handleGenerateBarcode() {
    setGenBarcode(true);
    try {
      const res = await fetch('/api/products/generate-barcode', { method: 'POST' });
      const json = await res.json();
      if (json.ok) update('barcode', json.data.barcode);
      else alert(json.error?.message ?? 'Failed');
    } finally {
      setGenBarcode(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    const payload = {
      product_name_en: form.product_name_en,
      product_name_ar: form.product_name_ar,
      brand_id: Number(form.brand_id),
      category_id: Number(form.category_id),
      subcategory_id: form.subcategory_id ? Number(form.subcategory_id) : null,
      product_type: form.product_type || null,
      size: form.size || null,
      color: form.color || null,
      variant: form.variant || null,
      price: Number(form.price),
      discount_price: form.discount_price ? Number(form.discount_price) : null,
      cost: form.cost ? Number(form.cost) : null,
      stock_quantity: Math.max(0, Math.floor(Number(form.stock_quantity) || 0)),
      barcode: form.barcode || null,
      snoonu_sku: form.snoonu_sku || null,
      description_en: form.description_en || null,
      description_ar: form.description_ar || null,
      usage_en: form.usage_en || null,
      usage_ar: form.usage_ar || null,
      keywords_en: form.keywords_en
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      keywords_ar: form.keywords_ar
        .split(/[،,]/)
        .map((k) => k.trim())
        .filter(Boolean),
      product_status: form.product_status,
    };

    try {
      const res = await fetch(`/api/products/${product.master_sku}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Update failed');
        setSubmitting(false);
        return;
      }
      setSuccess('Saved successfully.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* AI Autofill */}
      {product.image_url && (
        <Card className="!p-4 flex items-center justify-between bg-primary/5">
          <div className="text-sm">
            <div className="font-medium">Use AI to fill missing fields</div>
            <div className="text-xs text-muted-foreground">Reads the primary image and suggests improvements.</div>
          </div>
          <AIAutofillButton imageUrl={product.image_url} onApply={applyAI} />
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-medium mb-4">Names</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="name_en" required>English name</Label>
            <Input
              id="name_en"
              required
              minLength={3}
              value={form.product_name_en}
              onChange={(e) => update('product_name_en', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name_ar" required>Arabic name</Label>
            <Input
              id="name_ar"
              required
              minLength={3}
              dir="rtl"
              value={form.product_name_ar}
              onChange={(e) => update('product_name_ar', e.target.value)}
            />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">Classification</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label required>Brand</Label>
            <Select required value={form.brand_id} onChange={(e) => update('brand_id', e.target.value)}>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label required>Category</Label>
            <Select
              required
              value={form.category_id}
              onChange={(e) => {
                update('category_id', e.target.value);
                update('subcategory_id', '');
              }}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Subcategory</Label>
            <Select value={form.subcategory_id} onChange={(e) => update('subcategory_id', e.target.value)}>
              <option value="">None</option>
              {availableSubcategories.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Input value={form.product_type} onChange={(e) => update('product_type', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Size</Label>
            <Input value={form.size} onChange={(e) => update('size', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <Input value={form.color} onChange={(e) => update('color', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Variant</Label>
            <Input value={form.variant} onChange={(e) => update('variant', e.target.value)} />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">Pricing & inventory</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label required>Price (QAR)</Label>
            <Input
              type="number" step="0.01" min="0" required
              value={form.price} onChange={(e) => update('price', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Discount</Label>
            <Input
              type="number" step="0.01" min="0"
              value={form.discount_price} onChange={(e) => update('discount_price', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Cost</Label>
            <Input
              type="number" step="0.01" min="0"
              value={form.cost} onChange={(e) => update('cost', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Stock</Label>
            <Input
              type="number" min="0"
              value={form.stock_quantity} onChange={(e) => update('stock_quantity', e.target.value)}
            />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">Identifiers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Barcode</Label>
            <div className="flex gap-2">
              <Input value={form.barcode} onChange={(e) => update('barcode', e.target.value)} />
              <Button type="button" variant="secondary" onClick={handleGenerateBarcode} disabled={genBarcode}>
                {genBarcode ? '…' : 'Generate'}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Snoonu SKU</Label>
            <Input value={form.snoonu_sku} onChange={(e) => update('snoonu_sku', e.target.value)} />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">Descriptions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Description (EN)</Label>
            <Textarea value={form.description_en} onChange={(e) => update('description_en', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Description (AR)</Label>
            <Textarea dir="rtl" value={form.description_ar} onChange={(e) => update('description_ar', e.target.value)} />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">How to use</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Usage (EN)</Label>
            <Textarea value={form.usage_en} onChange={(e) => update('usage_en', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Usage (AR)</Label>
            <Textarea dir="rtl" value={form.usage_ar} onChange={(e) => update('usage_ar', e.target.value)} />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">SEO keywords</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Keywords (EN, comma-separated)</Label>
            <Input value={form.keywords_en} onChange={(e) => update('keywords_en', e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Keywords (AR، مفصولة بفاصلة)</Label>
            <Input dir="rtl" value={form.keywords_ar} onChange={(e) => update('keywords_ar', e.target.value)} />
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-medium mb-4">Status</h2>
        <Select value={form.product_status} onChange={(e) => update('product_status', e.target.value)}>
          <option value="draft">Draft</option>
          <option value="pending_approval">Pending approval</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="blocked">Blocked</option>
        </Select>
      </Card>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
          {error}
        </div>
      )}
      {success && (
        <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md p-3">
          {success}
        </div>
      )}

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
