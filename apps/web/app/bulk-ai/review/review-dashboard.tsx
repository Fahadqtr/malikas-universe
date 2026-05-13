'use client';

/**
 * ReviewDashboard — central operating UI for AI drafts.
 *
 * Top-level state:
 *   • drafts        Current page of AI draft products
 *   • metrics       KPI bar
 *   • status filter ready | needs_review | failed | approved | all
 *   • selection     Set<master_sku> for bulk actions
 *   • view mode     'grid' | 'table'
 *   • editing       master_sku currently in side-panel editor (null = none)
 *
 * Keyboard shortcuts:
 *   A = approve focused/selected
 *   R = reject focused/selected
 *   E = open editor for focused row
 *   G = grid mode | T = table mode
 *   / = focus search
 *   Esc = close editor / clear selection
 *
 * Architecture notes:
 *   • All mutations go through /api/bulk-ai/drafts/bulk-action so the same
 *     code path works for single-item and bulk operations.
 *   • Inline edits use PATCH /api/products/[sku] (existing endpoint).
 *   • Refetches after every mutation — no optimistic state to avoid drift.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, Card } from '@/components/ui';
import { DraftCard, DraftTableRow, type DraftItem } from './draft-card';
import { InlineEditor } from './inline-editor';
import { MetricsBar, type Metrics } from './metrics-bar';

type Ref = { id: number; name: string; code?: string | null };
type StatusFilter = 'all' | 'ready' | 'needs_review' | 'failed' | 'approved';
type SortMode = 'confidence_asc' | 'confidence_desc' | 'created_desc' | 'created_asc';
type ViewMode = 'grid' | 'table';

const PAGE_SIZE = 60;

export function ReviewDashboard({
  brands,
  categories,
}: {
  brands: Ref[];
  categories: Ref[];
}) {
  // ─── State ────────────────────────────────────────────────────────────────
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [counts, setCounts] = useState({ ready: 0, needs_review: 0, failed: 0, approved: 0 });
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  const [filter, setFilter] = useState<StatusFilter>('needs_review');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [brandFilter, setBrandFilter] = useState<number | ''>('');
  const [categoryFilter, setCategoryFilter] = useState<number | ''>('');
  const [sort, setSort] = useState<SortMode>('confidence_asc');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingSku, setEditingSku] = useState<string | null>(null);
  const [focusedSku, setFocusedSku] = useState<string | null>(null);
  const [zoomSku, setZoomSku] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);

  // ─── Debounce search ──────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // ─── Fetch drafts + metrics ───────────────────────────────────────────────
  const fetchDrafts = useCallback(async () => {
    setLoading(true);
    setBannerError(null);
    try {
      const params = new URLSearchParams({
        status: filter,
        sort,
        page: '1',
        page_size: String(PAGE_SIZE),
      });
      if (searchDebounced) params.set('q', searchDebounced);
      if (brandFilter) params.set('brand_id', String(brandFilter));
      if (categoryFilter) params.set('category_id', String(categoryFilter));

      const res = await fetch(`/api/bulk-ai/drafts?${params}`);
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setDrafts(body.data.items);
      setCounts(body.data.status_counts);
    } catch (e) {
      setBannerError(e instanceof Error ? e.message : 'Failed to load drafts');
    } finally {
      setLoading(false);
    }
  }, [filter, searchDebounced, brandFilter, categoryFilter, sort]);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/bulk-ai/drafts/metrics');
      const body = await res.json();
      if (body.ok) setMetrics(body.data);
    } catch {
      // Non-fatal — metrics are decorative
    }
  }, []);

  useEffect(() => {
    fetchDrafts();
  }, [fetchDrafts]);

  useEffect(() => {
    fetchMetrics();
    // Refresh metrics every 30s while page is open
    const t = setInterval(fetchMetrics, 30000);
    return () => clearInterval(t);
  }, [fetchMetrics]);

  // ─── Bulk action helper ───────────────────────────────────────────────────
  const runBulkAction = useCallback(
    async (action: 'approve' | 'reject' | 'retry' | 'export', skus?: string[]) => {
      const targetSkus = skus ?? Array.from(selected);
      if (targetSkus.length === 0) return;
      setWorking(true);
      try {
        if (action === 'export') {
          // CSV download via form post
          const res = await fetch('/api/bulk-ai/drafts/bulk-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, master_skus: targetSkus }),
          });
          if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `malikas-drafts-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          return;
        }

        const res = await fetch('/api/bulk-ai/drafts/bulk-action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, master_skus: targetSkus }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        if (body.data.failed?.length > 0) {
          setBannerError(
            `${body.data.failed.length} item(s) failed: ${body.data.failed[0].error}`,
          );
        }
        setSelected(new Set());
        await Promise.all([fetchDrafts(), fetchMetrics()]);
      } catch (e) {
        setBannerError(e instanceof Error ? e.message : 'Bulk action failed');
      } finally {
        setWorking(false);
      }
    },
    [selected, fetchDrafts, fetchMetrics],
  );

  // ─── Selection helpers ────────────────────────────────────────────────────
  const toggleSelect = useCallback((sku: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(drafts.map((d) => d.master_sku)));
  }, [drafts]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't fire if user is typing in an input
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        if (e.key === 'Escape') (tgt as HTMLInputElement).blur();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (editingSku) setEditingSku(null);
        else if (zoomSku) setZoomSku(null);
        else clearSelection();
        return;
      }
      const k = e.key.toLowerCase();
      const targetSku = focusedSku ?? (selected.size === 1 ? Array.from(selected)[0] : null);
      if (k === 'a' && (targetSku || selected.size > 0)) {
        e.preventDefault();
        runBulkAction('approve', selected.size > 0 ? undefined : [targetSku!]);
      } else if (k === 'r' && (targetSku || selected.size > 0)) {
        e.preventDefault();
        runBulkAction('reject', selected.size > 0 ? undefined : [targetSku!]);
      } else if (k === 'e' && targetSku) {
        e.preventDefault();
        setEditingSku(targetSku);
      } else if (k === 'g') {
        setViewMode('grid');
      } else if (k === 't') {
        setViewMode('table');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedSku, selected, editingSku, zoomSku, runBulkAction, clearSelection]);

  // ─── Derived ──────────────────────────────────────────────────────────────
  const totalShown = drafts.length;
  const selectedCount = selected.size;
  const allSelected = totalShown > 0 && selectedCount === totalShown;

  const filterChips = useMemo(
    () => [
      { id: 'all' as const, label: 'All', count: counts.ready + counts.needs_review + counts.failed + counts.approved },
      { id: 'ready' as const, label: 'Ready', count: counts.ready, color: 'text-green-700' },
      { id: 'needs_review' as const, label: 'Needs review', count: counts.needs_review, color: 'text-yellow-600' },
      { id: 'failed' as const, label: 'Failed', count: counts.failed, color: 'text-destructive' },
      { id: 'approved' as const, label: 'Approved', count: counts.approved, color: 'text-blue-600' },
    ],
    [counts],
  );

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {bannerError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 text-destructive p-3 text-sm flex items-center justify-between">
          <span>⚠ {bannerError}</span>
          <button onClick={() => setBannerError(null)} className="text-xs hover:underline">dismiss</button>
        </div>
      )}

      <MetricsBar metrics={metrics} />

      {/* Sticky filter bar */}
      <Card className="!p-3 sticky top-2 z-20 backdrop-blur supports-[backdrop-filter]:bg-card/85">
        <div className="flex flex-wrap items-center gap-2">
          {/* Status chips */}
          <div className="flex flex-wrap gap-1">
            {filterChips.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setFilter(c.id)}
                className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors
                  ${filter === c.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-accent'}
                `}
              >
                {c.label}
                <span className={`ml-1.5 text-xs ${filter === c.id ? 'opacity-80' : c.color ?? 'text-muted-foreground'}`}>
                  {c.count}
                </span>
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Search */}
          <Input
            ref={searchRef}
            placeholder="Search name/SKU…  (press / to focus)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />

          {/* Brand filter */}
          <Select
            value={String(brandFilter)}
            onChange={(e) => setBrandFilter(e.target.value ? Number(e.target.value) : '')}
            className="w-40"
          >
            <option value="">All brands</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>

          {/* Category filter */}
          <Select
            value={String(categoryFilter)}
            onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : '')}
            className="w-44"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>

          {/* Sort */}
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            className="w-44"
          >
            <option value="confidence_asc">Lowest confidence first</option>
            <option value="confidence_desc">Highest confidence first</option>
            <option value="created_desc">Newest first</option>
            <option value="created_asc">Oldest first</option>
          </Select>

          {/* View mode */}
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`px-3 py-1.5 text-xs font-medium ${viewMode === 'grid' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'}`}
              title="Grid mode (G)"
            >
              Grid
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`px-3 py-1.5 text-xs font-medium border-l border-border ${viewMode === 'table' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'}`}
              title="Table mode (T)"
            >
              Table
            </button>
          </div>
        </div>

        {/* Selection bar */}
        {selectedCount > 0 && (
          <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {selectedCount} selected
            </span>
            <button
              type="button"
              onClick={allSelected ? clearSelection : selectAll}
              className="text-xs text-primary hover:underline"
            >
              {allSelected ? 'Clear all' : `Select all ${totalShown}`}
            </button>
            <div className="flex-1" />
            <Button size="sm" onClick={() => runBulkAction('approve')} disabled={working}>
              ✓ Approve ({selectedCount})
            </Button>
            <Button size="sm" variant="secondary" onClick={() => runBulkAction('reject')} disabled={working}>
              ✗ Reject
            </Button>
            <Button size="sm" variant="ghost" onClick={() => runBulkAction('retry')} disabled={working}>
              ↻ Retry AI
            </Button>
            <Button size="sm" variant="ghost" onClick={() => runBulkAction('export')} disabled={working}>
              ⬇ Quick CSV
            </Button>
            <a
              href={`/export-center?skus=${encodeURIComponent(Array.from(selected).join(','))}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-3 py-1.5 text-xs rounded-md bg-muted hover:bg-accent font-medium"
            >
              → Export Center
            </a>
            <Button size="sm" variant="ghost" onClick={clearSelection} disabled={working}>
              Clear
            </Button>
          </div>
        )}
      </Card>

      {/* Body */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading drafts…</div>
      ) : drafts.length === 0 ? (
        <Card className="text-center py-12 text-muted-foreground">
          No drafts match these filters.
        </Card>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {drafts.map((d) => (
            <DraftCard
              key={d.master_sku}
              draft={d}
              selected={selected.has(d.master_sku)}
              focused={focusedSku === d.master_sku}
              onToggleSelect={() => toggleSelect(d.master_sku)}
              onFocus={() => setFocusedSku(d.master_sku)}
              onEdit={() => setEditingSku(d.master_sku)}
              onApprove={() => runBulkAction('approve', [d.master_sku])}
              onReject={() => runBulkAction('reject', [d.master_sku])}
              onZoomImage={() => setZoomSku(d.master_sku)}
              busy={working}
            />
          ))}
        </div>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={allSelected ? clearSelection : selectAll}
                    />
                  </th>
                  <th className="px-3 py-2 w-16 text-left">Image</th>
                  <th className="px-3 py-2 text-left">SKU / Name</th>
                  <th className="px-3 py-2 text-left">Brand</th>
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-left w-20">Confidence</th>
                  <th className="px-3 py-2 text-left w-20">Cost</th>
                  <th className="px-3 py-2 text-left w-24">Status</th>
                  <th className="px-3 py-2 text-right w-40">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {drafts.map((d) => (
                  <DraftTableRow
                    key={d.master_sku}
                    draft={d}
                    selected={selected.has(d.master_sku)}
                    focused={focusedSku === d.master_sku}
                    onToggleSelect={() => toggleSelect(d.master_sku)}
                    onFocus={() => setFocusedSku(d.master_sku)}
                    onEdit={() => setEditingSku(d.master_sku)}
                    onApprove={() => runBulkAction('approve', [d.master_sku])}
                    onReject={() => runBulkAction('reject', [d.master_sku])}
                    busy={working}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Inline editor side panel */}
      {editingSku && (
        <InlineEditor
          masterSku={editingSku}
          brands={brands}
          categories={categories}
          onClose={() => setEditingSku(null)}
          onSaved={async () => {
            setEditingSku(null);
            await fetchDrafts();
          }}
        />
      )}

      {/* Image zoom overlay */}
      {zoomSku && (
        <ImageZoom
          src={drafts.find((d) => d.master_sku === zoomSku)?.image_url ?? ''}
          alt={drafts.find((d) => d.master_sku === zoomSku)?.product_name_en ?? ''}
          onClose={() => setZoomSku(null)}
        />
      )}
    </div>
  );
}

// ─── Image zoom overlay ──────────────────────────────────────────────────────

function ImageZoom({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-8 cursor-zoom-out"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/20 flex items-center justify-center text-xl"
        aria-label="Close"
      >
        ×
      </button>
    </div>
  );
}
