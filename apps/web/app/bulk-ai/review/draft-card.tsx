'use client';

/**
 * DraftCard — grid-mode card for a single AI-generated draft product.
 * DraftTableRow — table-mode row of the same data.
 *
 * Status badge colors:
 *   ready         green
 *   needs_review  yellow
 *   failed        red
 *   approved      blue
 *
 * Confidence color (green >90 / yellow >75 / red <75) per spec.
 *
 * Marketplace Ready badge appears when all required fields are filled
 * AND price>0 AND stock>0.
 *
 * Readiness Badge shows the Shopify readiness score (computed server-side
 * in the drafts list endpoint) — gates the Push to Shopify button.
 */

import { useState } from 'react';
import { ReadinessBadge } from '@/components/readiness-badge';

export type DraftItem = {
  master_sku: string;
  product_name_en: string;
  product_name_ar: string;
  brand_id: number;
  category_id: number;
  product_type: string | null;
  size: string | null;
  color: string | null;
  price: number;
  stock_quantity: number;
  product_status: string;
  description_en: string | null;
  description_ar: string | null;
  keywords_en: string[] | null;
  keywords_ar: string[] | null;
  image_url: string | null;
  ai_confidence: number | null;
  ai_meta: Record<string, unknown> | null;
  created_at: string;
  brand: { id: number; name: string; name_ar?: string | null; code?: string | null } | null;
  category: { id: number; name: string; name_ar?: string | null; code?: string | null } | null;
  _duplicates: Array<{ master_sku: string; product_name_en: string; reason: string }>;
  _marketplace_ready: boolean;
  _ai_cost_usd: number;
  _ui_status: 'ready' | 'needs_review' | 'failed' | 'approved';
  _readiness?: { score: number; ready: boolean; error_count: number; warning_count: number };
};

// ─── Shared mini-components ──────────────────────────────────────────────────

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  const color =
    pct > 90
      ? 'bg-green-600 text-white'
      : pct > 75
        ? 'bg-yellow-500 text-white'
        : 'bg-red-600 text-white';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${color}`} title="AI confidence">
      {pct}%
    </span>
  );
}

export function StatusBadge({ status }: { status: DraftItem['_ui_status'] }) {
  const map = {
    ready: 'bg-green-600 text-white',
    needs_review: 'bg-yellow-500 text-white',
    failed: 'bg-destructive text-destructive-foreground',
    approved: 'bg-blue-600 text-white',
  } as const;
  const label = {
    ready: 'ready',
    needs_review: 'needs review',
    failed: 'failed',
    approved: 'approved',
  } as const;
  return (
    <span className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${map[status]}`}>
      {label[status]}
    </span>
  );
}

export function MarketplaceReadyBadge({ ready }: { ready: boolean }) {
  if (!ready) return null;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-600 text-white inline-flex items-center gap-1"
      title="All required fields filled — ready to publish"
    >
      ✓ Marketplace
    </span>
  );
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

// ─── DraftCard (grid mode) ───────────────────────────────────────────────────

export function DraftCard({
  draft,
  selected,
  focused,
  onToggleSelect,
  onFocus,
  onEdit,
  onApprove,
  onReject,
  onZoomImage,
  busy,
}: {
  draft: DraftItem;
  selected: boolean;
  focused: boolean;
  onToggleSelect: () => void;
  onFocus: () => void;
  onEdit: () => void;
  onApprove: () => void;
  onReject: () => void;
  onZoomImage: () => void;
  busy: boolean;
}) {
  const [hoverImage, setHoverImage] = useState(false);

  return (
    <div
      onClick={onFocus}
      className={`relative border rounded-lg overflow-hidden bg-card transition-all cursor-pointer
        ${selected ? 'ring-2 ring-primary border-primary' : focused ? 'border-primary/50' : 'border-border hover:border-border/80'}
      `}
    >
      {/* Selection checkbox */}
      <div className="absolute top-2 left-2 z-10">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded accent-primary cursor-pointer"
        />
      </div>

      {/* Top-right badges */}
      <div className="absolute top-2 right-2 z-10 flex flex-col items-end gap-1">
        <StatusBadge status={draft._ui_status} />
        <ConfidenceBadge confidence={draft.ai_confidence} />
        {draft._readiness && (
          <ReadinessBadge
            score={draft._readiness.score}
            ready={draft._readiness.ready}
            compact
            target="shopify"
          />
        )}
        <MarketplaceReadyBadge ready={draft._marketplace_ready} />
      </div>

      {/* Image */}
      <div
        className="aspect-square bg-muted relative overflow-hidden"
        onMouseEnter={() => setHoverImage(true)}
        onMouseLeave={() => setHoverImage(false)}
        onClick={(e) => {
          e.stopPropagation();
          onZoomImage();
        }}
      >
        {draft.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={draft.image_url}
            alt={draft.product_name_en}
            className={`w-full h-full object-cover transition-transform ${hoverImage ? 'scale-105' : ''}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">
            no image
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">{draft.master_sku}</span>
          <span className="text-[10px] text-muted-foreground">{fmtUsd(draft._ai_cost_usd)}</span>
        </div>

        <div className="space-y-0.5">
          <div className="text-sm font-medium line-clamp-2" title={draft.product_name_en}>
            {draft.product_name_en}
          </div>
          <div className="text-xs text-muted-foreground line-clamp-1 text-right" dir="rtl" title={draft.product_name_ar}>
            {draft.product_name_ar}
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {draft.brand?.name && (
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{draft.brand.name}</span>
          )}
          {draft.category?.name && (
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{draft.category.name}</span>
          )}
          {draft.size && (
            <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{draft.size}</span>
          )}
        </div>

        {/* Duplicate warning */}
        {draft._duplicates.length > 0 && (
          <div className="text-[11px] text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-1.5 py-1 leading-tight" title={draft._duplicates.map((d) => `${d.master_sku}: ${d.product_name_en}`).join('\n')}>
            ⚠ {draft._duplicates.length} possible duplicate{draft._duplicates.length === 1 ? '' : 's'}
          </div>
        )}

        {/* Action row */}
        <div
          className="flex gap-1.5 pt-1"
          onClick={(e) => e.stopPropagation()}
        >
          {draft._ui_status !== 'approved' && (
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="flex-1 px-2 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              title="Approve (A)"
            >
              ✓ Approve
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="flex-1 px-2 py-1 text-xs font-medium rounded bg-muted hover:bg-accent disabled:opacity-50"
            title="Edit (E)"
          >
            Edit
          </button>
          {draft._ui_status !== 'approved' && (
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="px-2 py-1 text-xs font-medium rounded bg-muted hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              title="Reject (R)"
            >
              ✗
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DraftTableRow (table mode) ──────────────────────────────────────────────

export function DraftTableRow({
  draft,
  selected,
  focused,
  onToggleSelect,
  onFocus,
  onEdit,
  onApprove,
  onReject,
  busy,
}: {
  draft: DraftItem;
  selected: boolean;
  focused: boolean;
  onToggleSelect: () => void;
  onFocus: () => void;
  onEdit: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <tr
      onClick={onFocus}
      className={`cursor-pointer transition-colors
        ${selected ? 'bg-primary/5' : focused ? 'bg-muted/30' : 'hover:bg-muted/20'}
      `}
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => { e.stopPropagation(); onToggleSelect(); }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded accent-primary cursor-pointer"
        />
      </td>
      <td className="px-3 py-2">
        {draft.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={draft.image_url} alt="" className="w-10 h-10 rounded object-cover" />
        ) : (
          <div className="w-10 h-10 rounded bg-muted" />
        )}
      </td>
      <td className="px-3 py-2 max-w-md">
        <div className="font-mono text-[10px] text-muted-foreground">{draft.master_sku}</div>
        <div className="text-sm font-medium truncate" title={draft.product_name_en}>
          {draft.product_name_en}
        </div>
        <div className="text-xs text-muted-foreground truncate text-right" dir="rtl" title={draft.product_name_ar}>
          {draft.product_name_ar}
        </div>
        {draft._duplicates.length > 0 && (
          <div className="text-[10px] text-yellow-700">⚠ {draft._duplicates.length} duplicate(s)</div>
        )}
      </td>
      <td className="px-3 py-2 text-sm">{draft.brand?.name ?? '—'}</td>
      <td className="px-3 py-2 text-sm">{draft.category?.name ?? '—'}</td>
      <td className="px-3 py-2">
        <ConfidenceBadge confidence={draft.ai_confidence} />
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{fmtUsd(draft._ai_cost_usd)}</td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={draft._ui_status} />
          {draft._readiness && (
            <ReadinessBadge
              score={draft._readiness.score}
              ready={draft._readiness.ready}
              compact
              target="shopify"
            />
          )}
          {draft._marketplace_ready && <MarketplaceReadyBadge ready />}
        </div>
      </td>
      <td
        className="px-3 py-2 text-right"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="inline-flex gap-1">
          {draft._ui_status !== 'approved' && (
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="px-2 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              title="Approve (A)"
            >
              ✓
            </button>
          )}
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="px-2 py-1 text-xs font-medium rounded bg-muted hover:bg-accent disabled:opacity-50"
            title="Edit (E)"
          >
            Edit
          </button>
          {draft._ui_status !== 'approved' && (
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="px-2 py-1 text-xs font-medium rounded bg-muted hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              title="Reject (R)"
            >
              ✗
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
