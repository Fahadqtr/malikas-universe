'use client';

import { useState, useRef } from 'react';
import { Button, Card, Input, Label } from '@/components/ui';

export type AISuggestion = {
  product_name_en: string | null;
  product_name_ar: string | null;
  product_type: string | null;
  size: string | null;
  variant: string | null;
  color: string | null;
  brand_hint: string | null;
  category_hint: string | null;
  subcategory_hint: string | null;
  description_en: string | null;
  description_ar: string | null;
  usage_en: string | null;
  usage_ar: string | null;
  keywords_en: string[] | null;
  keywords_ar: string[] | null;
  confidence?: number;
  reasoning?: string;
};

export type AIResolved = {
  brand_id: number | null;
  category_id: number | null;
  subcategory_id: number | null;
};

export type AIResult = {
  suggestion: AISuggestion;
  resolved: AIResolved;
  meta: {
    style_mode?: string;
    model: string;
    latency_ms: number;
    tokens: { input: number; output: number };
    estimated_cost_usd: number;
    fallback_used?: boolean;
  };
};

type FieldKey =
  | 'product_name_en'
  | 'product_name_ar'
  | 'product_type'
  | 'size'
  | 'variant'
  | 'color'
  | 'brand_id'
  | 'category_id'
  | 'subcategory_id'
  | 'description_en'
  | 'description_ar'
  | 'usage_en'
  | 'usage_ar'
  | 'keywords_en'
  | 'keywords_ar';

const ALL_FIELDS: FieldKey[] = [
  'product_name_en',
  'product_name_ar',
  'brand_id',
  'category_id',
  'subcategory_id',
  'product_type',
  'size',
  'variant',
  'color',
  'description_en',
  'description_ar',
  'usage_en',
  'usage_ar',
  'keywords_en',
  'keywords_ar',
];

const FIELD_LABELS: Record<FieldKey, string> = {
  product_name_en: 'Name (EN)',
  product_name_ar: 'Name (AR)',
  product_type: 'Product type',
  size: 'Size',
  variant: 'Variant',
  color: 'Color',
  brand_id: 'Brand',
  category_id: 'Category',
  subcategory_id: 'Subcategory',
  description_en: 'Description (EN)',
  description_ar: 'Description (AR)',
  usage_en: 'How to use (EN)',
  usage_ar: 'How to use (AR)',
  keywords_en: 'Keywords (EN)',
  keywords_ar: 'Keywords (AR)',
};

export type ApplyValues = Partial<Record<FieldKey, string | number | string[] | null>>;

type ImageSource =
  | { kind: 'none' }
  | { kind: 'uploaded'; url: string; preview: string; filename: string; sizeKb: number }
  | { kind: 'url'; url: string };

export function AIAutofillButton({
  imageUrl,
  allowUrlInput,
  onApply,
}: {
  imageUrl?: string | null;
  allowUrlInput?: boolean;
  onApply: (values: ApplyValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'upload' | 'url'>(imageUrl ? 'url' : 'upload');
  const [imageSource, setImageSource] = useState<ImageSource>(
    imageUrl ? { kind: 'url', url: imageUrl } : { kind: 'none' },
  );
  const [urlInput, setUrlInput] = useState(imageUrl ?? '');
  const [brandHint, setBrandHint] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingTemp, setUploadingTemp] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AIResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<FieldKey>>(new Set());

  function resetEverything() {
    setResult(null);
    setSelected(new Set());
    setError(null);
    setImageSource({ kind: 'none' });
    setUrlInput('');
    setBrandHint('');
    setTab('upload');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // ─── Upload temp file ──────────────────────────────────────────────────────
  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Only JPG, PNG, or WebP allowed.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image is over 5 MB. Compress it first.');
      return;
    }

    // Show a local preview immediately
    const localPreview = URL.createObjectURL(file);
    setUploadingTemp(true);
    setImageSource({
      kind: 'uploaded',
      url: '', // pending
      preview: localPreview,
      filename: file.name,
      sizeKb: Math.round(file.size / 1024),
    });

    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/ai/upload-temp', { method: 'POST', body: fd });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'Upload failed');
        setImageSource({ kind: 'none' });
        return;
      }
      setImageSource({
        kind: 'uploaded',
        url: json.data.url,
        preview: localPreview,
        filename: file.name,
        sizeKb: json.data.size_bytes ? Math.round(json.data.size_bytes / 1024) : Math.round(file.size / 1024),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
      setImageSource({ kind: 'none' });
    } finally {
      setUploadingTemp(false);
    }
  }

  function applyUrlInput() {
    setError(null);
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//.test(trimmed)) {
      setError('URL must start with http:// or https://');
      return;
    }
    setImageSource({ kind: 'url', url: trimmed });
  }

  // ─── Run AI ────────────────────────────────────────────────────────────────
  async function runAI() {
    if (imageSource.kind === 'none' || !imageSource.url) {
      setError('Please upload or enter an image URL first.');
      return;
    }
    setError(null);
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch('/api/ai/autofill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: imageSource.url,
          brand_hint: brandHint || undefined,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error?.message ?? 'AI call failed');
        return;
      }
      const r = json.data as AIResult;
      setResult(r);

      // Pre-select fields that have a value
      const auto = new Set<FieldKey>();
      if (r.suggestion.product_name_en) auto.add('product_name_en');
      if (r.suggestion.product_name_ar) auto.add('product_name_ar');
      if (r.resolved.brand_id) auto.add('brand_id');
      if (r.resolved.category_id) auto.add('category_id');
      if (r.resolved.subcategory_id) auto.add('subcategory_id');
      if (r.suggestion.product_type) auto.add('product_type');
      if (r.suggestion.size) auto.add('size');
      if (r.suggestion.variant) auto.add('variant');
      if (r.suggestion.color) auto.add('color');
      if (r.suggestion.description_en) auto.add('description_en');
      if (r.suggestion.description_ar) auto.add('description_ar');
      if (r.suggestion.usage_en) auto.add('usage_en');
      if (r.suggestion.usage_ar) auto.add('usage_ar');
      if (r.suggestion.keywords_en?.length) auto.add('keywords_en');
      if (r.suggestion.keywords_ar?.length) auto.add('keywords_ar');
      setSelected(auto);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }

  function toggleField(field: FieldKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  function apply() {
    if (!result) return;
    const values: ApplyValues = {};
    const s = result.suggestion;
    const r = result.resolved;
    for (const field of selected) {
      if (field === 'brand_id') values.brand_id = r.brand_id ?? undefined;
      else if (field === 'category_id') values.category_id = r.category_id ?? undefined;
      else if (field === 'subcategory_id') values.subcategory_id = r.subcategory_id ?? undefined;
      else if (field === 'keywords_en') values.keywords_en = s.keywords_en ?? [];
      else if (field === 'keywords_ar') values.keywords_ar = s.keywords_ar ?? [];
      else values[field] = s[field] ?? null;
    }
    onApply(values);
    setOpen(false);
    resetEverything();
  }

  function getDisplayValue(field: FieldKey): string {
    if (!result) return '';
    const s = result.suggestion;
    const r = result.resolved;
    if (field === 'brand_id')
      return r.brand_id
        ? `${s.brand_hint ?? '—'} (matched id ${r.brand_id})`
        : `${s.brand_hint ?? '—'} (NOT FOUND in brands table)`;
    if (field === 'category_id')
      return r.category_id ? `${s.category_hint ?? '—'} (matched)` : `${s.category_hint ?? '—'} (NOT FOUND)`;
    if (field === 'subcategory_id')
      return r.subcategory_id ? `${s.subcategory_hint ?? '—'} (matched)` : `${s.subcategory_hint ?? '—'} (NOT FOUND)`;
    if (field === 'keywords_en') return (s.keywords_en ?? []).join(', ');
    if (field === 'keywords_ar') return (s.keywords_ar ?? []).join('، ');
    const v = s[field];
    return v == null ? '' : String(v);
  }

  const canRun = imageSource.kind !== 'none' && !!imageSource.url && !running && !uploadingTemp;

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        ✨ AI Autofill
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-card rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 space-y-4">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-semibold">AI Autofill</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Claude reads the product image and suggests fields. Review and apply only what you want.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setOpen(false);
                    resetEverything();
                  }}
                  className="text-muted-foreground hover:text-foreground text-2xl leading-none"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              {/* Image source picker */}
              {!result && (
                <>
                  {/* Tabs */}
                  <div className="flex border-b border-border">
                    <button
                      type="button"
                      onClick={() => setTab('upload')}
                      className={`px-4 py-2 text-sm font-medium transition-colors ${
                        tab === 'upload'
                          ? 'border-b-2 border-primary text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      📁 Upload image
                    </button>
                    {allowUrlInput && (
                      <button
                        type="button"
                        onClick={() => setTab('url')}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          tab === 'url'
                            ? 'border-b-2 border-primary text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        🔗 Paste URL
                      </button>
                    )}
                  </div>

                  {/* Upload tab */}
                  {tab === 'upload' && (
                    <Card>
                      <div className="space-y-3">
                        <div>
                          <Label htmlFor="ai_file">Image file</Label>
                          <input
                            ref={fileInputRef}
                            id="ai_file"
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={handleFilePick}
                            disabled={uploadingTemp}
                            className="block w-full text-sm border border-input bg-background rounded-md px-3 py-2 mt-1"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            JPG / PNG / WebP. Max 5 MB. Image is uploaded to a temp folder, not linked to any product.
                          </p>
                        </div>
                        {uploadingTemp && (
                          <p className="text-xs text-primary">Uploading to temp storage…</p>
                        )}
                      </div>
                    </Card>
                  )}

                  {/* URL tab */}
                  {tab === 'url' && allowUrlInput && (
                    <Card>
                      <div className="space-y-3">
                        <div>
                          <Label htmlFor="ai_url">Public image URL</Label>
                          <div className="flex gap-2 mt-1">
                            <Input
                              id="ai_url"
                              type="url"
                              value={urlInput}
                              onChange={(e) => setUrlInput(e.target.value)}
                              placeholder="https://cdn.example.com/product.jpg"
                            />
                            <Button type="button" variant="secondary" onClick={applyUrlInput}>
                              Preview
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            URL must be public so Claude can fetch it.
                          </p>
                        </div>
                      </div>
                    </Card>
                  )}

                  {/* Preview */}
                  {imageSource.kind !== 'none' && (
                    <Card>
                      <div className="flex gap-4 items-start">
                        <div className="w-32 h-32 bg-muted rounded-md overflow-hidden flex-shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={imageSource.kind === 'uploaded' ? imageSource.preview : imageSource.url}
                            alt="Preview"
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="flex-1 min-w-0 text-sm">
                          <div className="font-medium">Preview</div>
                          {imageSource.kind === 'uploaded' && (
                            <>
                              <div className="text-xs text-muted-foreground mt-1 truncate" title={imageSource.filename}>
                                {imageSource.filename}
                              </div>
                              <div className="text-xs text-muted-foreground">{imageSource.sizeKb} KB</div>
                              {!imageSource.url && (
                                <div className="text-xs text-yellow-700 mt-1">Uploading…</div>
                              )}
                            </>
                          )}
                          {imageSource.kind === 'url' && (
                            <div className="text-xs text-muted-foreground mt-1 break-all">{imageSource.url}</div>
                          )}
                        </div>
                      </div>
                    </Card>
                  )}

                  {/* Brand hint + Run AI */}
                  <Card>
                    <div className="space-y-3">
                      <div>
                        <Label htmlFor="ai_brand">Brand hint (optional)</Label>
                        <Input
                          id="ai_brand"
                          value={brandHint}
                          onChange={(e) => setBrandHint(e.target.value)}
                          placeholder="e.g., Medicube — leave blank to let AI detect"
                          className="mt-1"
                        />
                      </div>
                      <Button onClick={runAI} disabled={!canRun} className="w-full">
                        {running ? 'Analyzing image with Claude…' : '✨ Run AI'}
                      </Button>
                    </div>
                  </Card>

                  {error && (
                    <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3">
                      {error}
                    </div>
                  )}
                </>
              )}

              {/* Results */}
              {result && (
                <>
                  <Card className="!p-4">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">Confidence:</span>{' '}
                        {((result.suggestion.confidence ?? 0) * 100).toFixed(0)}%
                        {result.meta.style_mode && (
                          <span className="px-2 py-0.5 text-[10px] rounded bg-primary/10 text-primary border border-primary/30 uppercase tracking-wide">
                            {result.meta.style_mode} style
                          </span>
                        )}
                        {result.meta.fallback_used && (
                          <span className="px-2 py-0.5 text-[10px] rounded bg-yellow-500/15 text-yellow-800 border border-yellow-500/30">
                            AR fallback used
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground">
                        {result.meta.tokens.input}↓ {result.meta.tokens.output}↑ tokens · $
                        {result.meta.estimated_cost_usd.toFixed(4)} · {result.meta.latency_ms}ms
                      </div>
                    </div>
                    {result.suggestion.reasoning && (
                      <p className="text-xs text-muted-foreground mt-2 italic">{result.suggestion.reasoning}</p>
                    )}
                  </Card>

                  <div className="space-y-2">
                    {ALL_FIELDS.map((field) => {
                      const value = getDisplayValue(field);
                      if (!value) return null;
                      const checked = selected.has(field);
                      return (
                        <label
                          key={field}
                          className={`flex items-start gap-3 p-3 border rounded-md cursor-pointer transition-colors ${
                            checked ? 'bg-primary/5 border-primary' : 'bg-card border-border hover:bg-muted/30'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleField(field)}
                            className="mt-0.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-muted-foreground">{FIELD_LABELS[field]}</div>
                            <div
                              className="text-sm break-words whitespace-pre-wrap leading-relaxed"
                              dir={field.endsWith('_ar') || field === 'product_name_ar' ? 'rtl' : 'ltr'}
                            >
                              {value}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  <div className="flex gap-3 justify-end pt-3 border-t border-border">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setResult(null);
                        setSelected(new Set());
                      }}
                    >
                      Run again
                    </Button>
                    <Button onClick={apply} disabled={selected.size === 0}>
                      Apply {selected.size} {selected.size === 1 ? 'field' : 'fields'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
