/**
 * /snoonu-import/new — Start a new Snoonu import batch.
 *
 * 4 input modes:
 *   1. Single URL  — one product page link
 *   2. Category    — a Snoonu listing URL (caller pastes the product URLs from it)
 *   3. Paste list  — newline-separated URLs (up to 500)
 *   4. CSV upload  — one URL per row, optional "label" column
 *
 * On submit:
 *   POST /api/snoonu-import/start  →  { batch_id }
 *   POST /api/snoonu-import/[batch_id]/process  (fire-and-poll)
 *   Redirect → /snoonu-import/[batch_id]/review
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, Badge } from '@/components/ui';

type Mode = 'single_url' | 'category_url' | 'paste_list' | 'csv_upload';

const MODE_META: Record<Mode, { title: string; subtitle: string; icon: string }> = {
  single_url: {
    title: 'Single URL',
    subtitle: 'One product page',
    icon: '🔗',
  },
  category_url: {
    title: 'Category page',
    subtitle: 'Paste URLs scraped from a category listing',
    icon: '📂',
  },
  paste_list: {
    title: 'Paste list',
    subtitle: 'Newline-separated URLs (up to 500)',
    icon: '📋',
  },
  csv_upload: {
    title: 'CSV upload',
    subtitle: 'One URL per row',
    icon: '📄',
  },
};

export default function NewSnoonuImportPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('single_url');
  const [label, setLabel] = useState('');
  const [singleUrl, setSingleUrl] = useState('');
  const [categoryUrl, setCategoryUrl] = useState('');
  const [categoryProductUrls, setCategoryProductUrls] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvPreview, setCsvPreview] = useState<{ urls: string[]; total_rows: number; rejected: string[]; head: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');

  function extractUrls(text: string): string[] {
    return text
      .split(/\r?\n|,|\s+/)
      .map((s) => s.trim())
      .filter((s) => /^https?:\/\//i.test(s));
  }

  async function readCsvUrls(
    file: File,
  ): Promise<{ urls: string[]; total_rows: number; sample: string[]; rejected: string[] }> {
    const raw = await file.text();
    // Strip UTF-8 BOM if present
    const text = raw.replace(/^﻿/, '');
    const lines = text.split(/\r?\n/);
    const urls: string[] = [];
    const rejected: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      // Split on comma/semicolon/tab/pipe, strip wrapping quotes
      const cells = line
        .split(/[,;\t|]/)
        .map((c) => c.replace(/^["']|["']$/g, '').trim());

      for (const cell of cells) {
        if (!cell) continue;

        // Direct full URL with scheme
        if (/^https?:\/\//i.test(cell)) {
          if (/snoonu/i.test(cell)) urls.push(cell);
          else rejected.push(cell);
          continue;
        }

        // Schemeless host (e.g. "snoonu.com/qa/en/p/...")
        if (/^(www\.)?snoonu\.com\//i.test(cell)) {
          urls.push(`https://${cell.replace(/^www\./i, '')}`);
          continue;
        }

        // Slug only — looks like "/qa/en/p/something" or "qa/en/p/something"
        if (/^\/?qa\/(en|ar)\/p\//i.test(cell)) {
          const clean = cell.replace(/^\/+/, '');
          urls.push(`https://snoonu.com/${clean}`);
          continue;
        }
      }
    }

    const unique = Array.from(new Set(urls));
    return {
      urls: unique,
      total_rows: lines.filter((l) => l.trim()).length,
      sample: unique.slice(0, 3),
      rejected: rejected.slice(0, 3),
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setProgress('Preparing URLs…');

    try {
      // Build the request body based on mode
      let body: Record<string, unknown>;
      if (mode === 'single_url') {
        if (!singleUrl.trim()) throw new Error('Enter a Snoonu URL');
        body = { mode: 'single_url', url: singleUrl.trim(), label: label || undefined };
      } else if (mode === 'category_url') {
        if (!categoryUrl.trim()) throw new Error('Enter a category URL');
        const urls = extractUrls(categoryProductUrls);
        if (urls.length === 0) {
          throw new Error('Paste the product URLs from the category listing below');
        }
        body = { mode: 'category_url', url: categoryUrl.trim(), urls, label: label || undefined };
      } else if (mode === 'paste_list') {
        const urls = extractUrls(pasteText);
        if (urls.length === 0) throw new Error('No URLs detected');
        body = { mode: 'paste_list', urls, label: label || undefined };
      } else {
        if (!csvFile) throw new Error('Choose a CSV file');
        const parsed = await readCsvUrls(csvFile);
        if (parsed.urls.length === 0) {
          throw new Error(
            `No Snoonu URLs found in CSV (${parsed.total_rows} rows scanned). ` +
              (parsed.rejected.length > 0
                ? `Saw non-Snoonu URLs like: ${parsed.rejected.join(', ')}. `
                : '') +
              `The parser accepts: full https URLs containing "snoonu", schemeless snoonu.com URLs, or slugs starting with /qa/en/p/.`,
          );
        }
        setProgress(`Detected ${parsed.urls.length} URLs in CSV (${parsed.total_rows} rows scanned)`);
        body = { mode: 'csv_upload', filename: csvFile.name, urls: parsed.urls, label: label || undefined };
      }

      // 1. Start the batch
      setProgress('Creating batch…');
      const startRes = await fetch('/api/snoonu-import/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const startData = await startRes.json();
      if (!startData.ok) throw new Error(startData.error?.message ?? 'Failed to start batch');

      const batchId = startData.data.batch_id as number;
      setProgress(`Batch #${batchId} created. Extracting ${startData.data.total_items} products…`);

      // 2. Fire-and-forget process. The review page polls /status.
      void fetch(`/api/snoonu-import/${batchId}/process`, { method: 'POST' });

      // 3. Redirect to review (which will show progress live)
      router.push(`/snoonu-import/${batchId}/review`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
      setProgress('');
    }
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto p-8 space-y-6">
        <header>
          <Link href="/snoonu-import" className="text-sm text-muted-foreground hover:text-foreground">
            ← Snoonu Import
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight mt-1">New import</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pull products from Snoonu. Pick your input style below.
          </p>
        </header>

        {/* Mode picker */}
        <div className="grid grid-cols-2 gap-3">
          {(Object.keys(MODE_META) as Mode[]).map((m) => {
            const meta = MODE_META[m];
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`text-left rounded-lg border p-4 transition ${
                  active
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl">{meta.icon}</span>
                  <span className="font-medium">{meta.title}</span>
                  {active && <span className="ml-auto"><Badge variant="default">Selected</Badge></span>}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{meta.subtitle}</p>
              </button>
            );
          })}
        </div>

        <Card>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Optional label */}
            <div>
              <label className="block text-sm font-medium mb-1">Batch label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. K-beauty refresh — Oct 2026"
                className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                maxLength={120}
              />
            </div>

            {/* Mode-specific inputs */}
            {mode === 'single_url' && (
              <div>
                <label className="block text-sm font-medium mb-1">Product URL</label>
                <input
                  type="url"
                  value={singleUrl}
                  onChange={(e) => setSingleUrl(e.target.value)}
                  placeholder="https://snoonu.com/qa/en/p/medicube-zero-pore-pad-2-0"
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background font-mono"
                  required
                />
              </div>
            )}

            {mode === 'category_url' && (
              <>
                <div>
                  <label className="block text-sm font-medium mb-1">Category URL</label>
                  <input
                    type="url"
                    value={categoryUrl}
                    onChange={(e) => setCategoryUrl(e.target.value)}
                    placeholder="https://snoonu.com/qa/en/c/skincare"
                    className="w-full rounded-md border px-3 py-2 text-sm bg-background font-mono"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Product URLs from this category</label>
                  <textarea
                    value={categoryProductUrls}
                    onChange={(e) => setCategoryProductUrls(e.target.value)}
                    rows={8}
                    placeholder={'https://snoonu.com/qa/en/p/product-1\nhttps://snoonu.com/qa/en/p/product-2\n…'}
                    className="w-full rounded-md border px-3 py-2 text-sm bg-background font-mono"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Open the category in your browser, scroll to load everything, copy product links and paste here.
                  </p>
                </div>
              </>
            )}

            {mode === 'paste_list' && (
              <div>
                <label className="block text-sm font-medium mb-1">URLs (one per line)</label>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={12}
                  placeholder={'https://snoonu.com/qa/en/p/product-1\nhttps://snoonu.com/qa/en/p/product-2'}
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background font-mono"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Lines are auto-split on newlines, commas, and whitespace. Up to 500.
                </p>
              </div>
            )}

            {mode === 'csv_upload' && (
              <div>
                <label className="block text-sm font-medium mb-1">CSV file</label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={async (e) => {
                    const f = e.target.files?.[0] ?? null;
                    setCsvFile(f);
                    setCsvPreview(null);
                    if (!f) return;
                    const parsed = await readCsvUrls(f);
                    const raw = (await f.text()).replace(/^﻿/, '');
                    const head = raw.split(/\r?\n/).slice(0, 3);
                    setCsvPreview({
                      urls: parsed.urls,
                      total_rows: parsed.total_rows,
                      rejected: parsed.rejected,
                      head,
                    });
                  }}
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Accepts full <code>https://snoonu.com/...</code> URLs, schemeless <code>snoonu.com/...</code>, or product slugs like <code>/qa/en/p/medicube-zero-pore-pad</code>. Extra columns are ignored.
                </p>

                {csvPreview && (
                  <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span>
                        <strong className={csvPreview.urls.length > 0 ? 'text-emerald-700' : 'text-red-700'}>
                          {csvPreview.urls.length}
                        </strong>{' '}
                        Snoonu URLs found
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {csvPreview.total_rows} rows scanned
                      </span>
                    </div>
                    <div className="text-xs">
                      <div className="font-medium text-muted-foreground uppercase tracking-wide mb-1">
                        First 3 rows of your file
                      </div>
                      <pre className="bg-background border rounded p-2 text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
                        {csvPreview.head.join('\n')}
                      </pre>
                    </div>
                    {csvPreview.urls.length > 0 && (
                      <div className="text-xs">
                        <div className="font-medium text-emerald-700 uppercase tracking-wide mb-1">
                          Sample URLs detected
                        </div>
                        <ul className="space-y-0.5 font-mono">
                          {csvPreview.urls.slice(0, 3).map((u, i) => (
                            <li key={i} className="truncate">{u}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {csvPreview.urls.length === 0 && csvPreview.rejected.length > 0 && (
                      <div className="text-xs">
                        <div className="font-medium text-red-700 uppercase tracking-wide mb-1">
                          URLs rejected (not Snoonu)
                        </div>
                        <ul className="space-y-0.5 font-mono">
                          {csvPreview.rejected.map((u, i) => (
                            <li key={i} className="truncate">{u}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            {progress && submitting && (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 flex items-center gap-2">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                {progress}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t">
              <Link href="/snoonu-import">
                <Button type="button" variant="ghost">
                  Cancel
                </Button>
              </Link>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Starting…' : 'Start extraction →'}
              </Button>
            </div>
          </form>
        </Card>

        <Card className="bg-muted/30">
          <h3 className="font-medium mb-1 text-sm">What happens next</h3>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            <li>System fetches each Snoonu page (politely — 1.5s between requests)</li>
            <li>Extracts name/price/image/SKU/barcode/description (EN + AR)</li>
            <li>Generates Malika SKU and renames image to <code>{`{SKU}`}.jpg</code></li>
            <li>Detects variants (color, size, shade, bundle) from name + listing</li>
            <li>Matches against your catalog (SKU, barcode, name, brand+name, price)</li>
            <li>You review every item before anything writes to <code>products</code></li>
          </ol>
        </Card>
      </div>
    </main>
  );
}
