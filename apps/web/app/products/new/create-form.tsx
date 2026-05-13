'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Input, Label, Select, Textarea } from '@/components/ui';
import { AIAutofillButton, type ApplyValues } from '@/components/ai-autofill-modal';

type Brand = { id: number; name: string };
type Category = { id: number; name: string; code: string };
type Subcategory = { id: number; category_id: number; name: string };

export function ProductCreateForm({
  brands,
  categories,
  subcategories,
}: {
  brands: Brand[];
  categories: Category[];
  subcategories: Subcategory[];
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [productNameEn, setProductNameEn] = useState('');
  const [productNameAr, setProductNameAr] = useState('');
  const [brandId, setBrandId] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [subcategoryId, setSubcategoryId] = useState<string>('');
  const [productType, setProductType] = useState('');
  const [size, setSize] = useState('');
  const [color, setColor] = useState('');
  const [variant, setVariant] = useState('');
  const [price, setPrice] = useState('');
  const [discountPrice, setDiscountPrice] = useState('');
  const [cost, setCost] = useState('');
  const [stockQuantity, setStockQuantity] = useState('0');
  const [barcode, setBarcode] = useState('');
  const [snoonuSku, setSnoonuSku] = useState('');
  const [descriptionEn, setDescriptionEn] = useState('');
  const [descriptionAr, setDescriptionAr] = useState('');
  const [usageEn, setUsageEn] = useState('');
  const [usageAr, setUsageAr] = useState('');
  const [keywordsEn, setKeywordsEn] = useState('');
  const [keywordsAr, setKeywordsAr] = useState('');
  const [generatingBarcode, setGeneratingBarcode] = useState(false);

  // Filter subcategories by selected category
  const availableSubcategories = useMemo(
    () => subcategories.filter((s) => s.category_id === Number(categoryId)),
    [categoryId, subcategories],
  );

  function applyAI(values: ApplyValues) {
    if (typeof values.product_name_en === 'string') setProductNameEn(values.product_name_en);
    if (typeof values.product_name_ar === 'string') setProductNameAr(values.product_name_ar);
    if (typeof values.brand_id === 'number') setBrandId(String(values.brand_id));
    if (typeof values.category_id === 'number') {
      setCategoryId(String(values.category_id));
      setSubcategoryId(''); // reset subcategory since main category changed
    }
    if (typeof values.subcategory_id === 'number') setSubcategoryId(String(values.subcategory_id));
    if (typeof values.product_type === 'string') setProductType(values.product_type);
    if (typeof values.size === 'string') setSize(values.size);
    if (typeof values.variant === 'string') setVariant(values.variant);
    if (typeof values.color === 'string') setColor(values.color);
    if (typeof values.description_en === 'string') setDescriptionEn(values.description_en);
    if (typeof values.description_ar === 'string') setDescriptionAr(values.description_ar);
    if (typeof values.usage_en === 'string') setUsageEn(values.usage_en);
    if (typeof values.usage_ar === 'string') setUsageAr(values.usage_ar);
    if (Array.isArray(values.keywords_en)) setKeywordsEn(values.keywords_en.join(', '));
    if (Array.isArray(values.keywords_ar)) setKeywordsAr(values.keywords_ar.join('، '));
  }

  async function handleGenerateBarcode() {
    setGeneratingBarcode(true);
    try {
      const res = await fetch('/api/products/generate-barcode', { method: 'POST' });
      const json = await res.json();
      if (json.ok) setBarcode(json.data.barcode);
      else alert(`Barcode error: ${json.error?.message}`);
    } finally {
      setGeneratingBarcode(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload = {
        product_name_en: productNameEn.trim(),
        product_name_ar: productNameAr.trim(),
        brand_id: Number(brandId),
        category_id: Number(categoryId),
        subcategory_id: subcategoryId ? Number(subcategoryId) : null,
        product_type: productType.trim() || null,
        size: size.trim() || null,
        color: color.trim() || null,
        variant: variant.trim() || null,
        price: Number(price),
        discount_price: discountPrice ? Number(discountPrice) : null,
        cost: cost ? Number(cost) : null,
        stock_quantity: Math.max(0, Math.floor(Number(stockQuantity) || 0)),
        barcode: barcode.trim() || null,
        snoonu_sku: snoonuSku.trim() || null,
        description_en: descriptionEn.trim() || null,
        description_ar: descriptionAr.trim() || null,
        usage_en: usageEn.trim() || null,
        usage_ar: usageAr.trim() || null,
        keywords_en: keywordsEn
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
        keywords_ar: keywordsAr
          .split(/[،,]/)
          .map((k) => k.trim())
          .filter(Boolean),
      };

      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Create failed');
        setSubmitting(false);
        return;
      }
      // Redirect to edit page of the new product
      router.push(`/products/${json.data.master_sku}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* AI Autofill toolbar */}
      <Card className="!p-4 flex items-center justify-between bg-primary/5">
        <div className="text-sm">
          <div className="font-medium">Speed it up with AI</div>
          <div className="text-xs text-muted-foreground">
            Paste an image URL (Snoonu listing, manufacturer site) → AI suggests name, brand, category, description.
          </div>
        </div>
        <AIAutofillButton allowUrlInput onApply={applyAI} />
      </Card>

      {/* Names */}
      <Card>
        <h2 className="text-lg font-medium mb-4">Names</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="name_en" required>Product name (English)</Label>
            <Input
              id="name_en"
              required
              minLength={3}
              value={productNameEn}
              onChange={(e) => setProductNameEn(e.target.value)}
              placeholder="Medicube Zero Pore Pad 2.0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name_ar" required>Product name (Arabic)</Label>
            <Input
              id="name_ar"
              required
              minLength={3}
              value={productNameAr}
              onChange={(e) => setProductNameAr(e.target.value)}
              placeholder="ميديكيوب باد المسام صفر 2.0"
              dir="rtl"
            />
          </div>
        </div>
      </Card>

      {/* Classification */}
      <Card>
        <h2 className="text-lg font-medium mb-4">Classification</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="brand" required>Brand</Label>
            <Select id="brand" required value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">Choose brand…</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="category" required>Category</Label>
            <Select
              id="category"
              required
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setSubcategoryId(''); // reset sub when main changes
              }}
            >
              <option value="">Choose category…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="subcategory">Subcategory</Label>
            <Select
              id="subcategory"
              value={subcategoryId}
              onChange={(e) => setSubcategoryId(e.target.value)}
              disabled={!categoryId || availableSubcategories.length === 0}
            >
              <option value="">{categoryId ? 'None / Optional' : 'Pick category first'}</option>
              {availableSubcategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4">
          <div className="space-y-1.5">
            <Label htmlFor="product_type">Product type</Label>
            <Input
              id="product_type"
              value={productType}
              onChange={(e) => setProductType(e.target.value)}
              placeholder="Toner Pad"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="size">Size</Label>
            <Input id="size" value={size} onChange={(e) => setSize(e.target.value)} placeholder="70pcs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="color">Color</Label>
            <Input id="color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="—" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="variant">Variant</Label>
            <Input id="variant" value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="2.0" />
          </div>
        </div>
      </Card>

      {/* Pricing + stock */}
      <Card>
        <h2 className="text-lg font-medium mb-4">Pricing & inventory</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="price" required>Price (QAR)</Label>
            <Input
              id="price"
              type="number"
              step="0.01"
              min="0"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="89.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="discount_price">Discount price</Label>
            <Input
              id="discount_price"
              type="number"
              step="0.01"
              min="0"
              value={discountPrice}
              onChange={(e) => setDiscountPrice(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cost">Cost</Label>
            <Input
              id="cost"
              type="number"
              step="0.01"
              min="0"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stock">Stock quantity</Label>
            <Input
              id="stock"
              type="number"
              min="0"
              value={stockQuantity}
              onChange={(e) => setStockQuantity(e.target.value)}
            />
          </div>
        </div>
      </Card>

      {/* IDs */}
      <Card>
        <h2 className="text-lg font-medium mb-4">Identifiers</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="barcode">Barcode (EAN-13 / UPC)</Label>
            <div className="flex gap-2">
              <Input
                id="barcode"
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="Leave blank or generate"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleGenerateBarcode}
                disabled={generatingBarcode}
              >
                {generatingBarcode ? '…' : 'Generate'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Use manufacturer barcode when available, else generate.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="snoonu_sku">Snoonu SKU</Label>
            <Input
              id="snoonu_sku"
              value={snoonuSku}
              onChange={(e) => setSnoonuSku(e.target.value)}
              placeholder="SNO-12345 (optional)"
            />
          </div>
        </div>
      </Card>

      {/* Descriptions */}
      <Card>
        <h2 className="text-lg font-medium mb-4">Descriptions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="desc_en">Description (EN)</Label>
            <Textarea
              id="desc_en"
              value={descriptionEn}
              onChange={(e) => setDescriptionEn(e.target.value)}
              placeholder="2-3 lines, benefit-led, Sephora-style"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="desc_ar">Description (AR)</Label>
            <Textarea
              id="desc_ar"
              value={descriptionAr}
              onChange={(e) => setDescriptionAr(e.target.value)}
              placeholder="نص بأسلوب سيفورا الخليجي"
              dir="rtl"
            />
          </div>
        </div>
      </Card>

      {/* Usage */}
      <Card>
        <h2 className="text-lg font-medium mb-4">How to use</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="usage_en">Usage (EN)</Label>
            <Textarea
              id="usage_en"
              value={usageEn}
              onChange={(e) => setUsageEn(e.target.value)}
              placeholder="1. Apply to clean skin.&#10;2. Massage gently."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="usage_ar">Usage (AR)</Label>
            <Textarea
              id="usage_ar"
              value={usageAr}
              onChange={(e) => setUsageAr(e.target.value)}
              placeholder="١. ضعي على بشرة نظيفة.&#10;٢. دلكي بلطف."
              dir="rtl"
            />
          </div>
        </div>
      </Card>

      {/* Keywords */}
      <Card>
        <h2 className="text-lg font-medium mb-4">SEO keywords</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="keywords">Keywords (EN, comma-separated)</Label>
            <Input
              id="keywords"
              value={keywordsEn}
              onChange={(e) => setKeywordsEn(e.target.value)}
              placeholder="pore care, toner pad, k-beauty"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="keywords_ar">Keywords (AR، مفصولة بفاصلة)</Label>
            <Input
              id="keywords_ar"
              value={keywordsAr}
              onChange={(e) => setKeywordsAr(e.target.value)}
              placeholder="باد، تونر، عناية بالبشرة"
              dir="rtl"
            />
          </div>
        </div>
      </Card>

      {/* Error */}
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
          {error}
        </div>
      )}

      {/* Submit */}
      <div className="flex gap-3 justify-end">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create product'}
        </Button>
      </div>
    </form>
  );
}
