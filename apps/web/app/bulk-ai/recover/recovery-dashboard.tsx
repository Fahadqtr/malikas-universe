'use client';

/**
 * RecoveryDashboard — client UI for the Bulk-AI recovery queue.
 *
 * Reads pending drafts from GET /api/bulk-ai/recover and recovers them one at a
 * time through POST /api/bulk-ai/recover. All data access goes through the API —
 * this component never imports a Supabase client.
 *
 * Concurrency: a per-draft busy Set makes double-clicks / concurrent submits on
 * the same draft impossible while leaving other drafts free to submit. Every
 * request releases its draft in `finally`, so a network error never sticks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Card } from '@/components/ui';
import { RecoveryDraftCard } from './recovery-draft-card';
import {
  type RecoveryDraft,
  type RefRow,
  type SubcategoryRow,
  type RecoveryOverrides,
  applyRecoverySuccess,
  recoveryErrorMessage,
  productHref,
} from './recovery-logic';

const PAGE_SIZE = 50;

interface Toast {
  masterSku: string | null;
  alreadyRecovered: boolean;
}

export function RecoveryDashboard({
  brands,
  categories,
  subcategories,
}: {
  brands: RefRow[];
  categories: RefRow[];
  subcategories: SubcategoryRow[];
}) {
  const [items, setItems] = useState<RecoveryDraft[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Per-draft submission lock. `busyRef` is the SYNCHRONOUS source of truth
  // (checked + set before any await, so double-clicks can't both pass); `busyIds`
  // is the mirrored React state that drives disabled buttons/fields.
  const busyRef = useRef<Set<number>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<number>>(() => new Set());
  const [cardErrors, setCardErrors] = useState<Record<number, string>>({});
  const [toast, setToast] = useState<Toast | null>(null);

  // ─── Load a page of pending drafts ──────────────────────────────────────────
  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      const res = await fetch(`/api/bulk-ai/recover?${params.toString()}`);
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body?.error?.code ?? `HTTP ${res.status}`);
      setItems(body.data.items ?? []);
      setTotal(body.data.total ?? 0);
      setOffset(body.data.offset ?? nextOffset);
    } catch {
      setLoadError('Could not load the recovery queue. Please retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  // ─── Recover one draft ──────────────────────────────────────────────────────
  const recover = useCallback(
    async (draftId: number, overrides: RecoveryOverrides) => {
      // Synchronous per-draft guard BEFORE any await — a second click on the
      // same draft returns immediately; other drafts are unaffected.
      if (busyRef.current.has(draftId)) return;
      busyRef.current.add(draftId);
      setBusyIds(new Set(busyRef.current));

      setCardErrors((prev) => {
        if (!prev[draftId]) return prev;
        const next = { ...prev };
        delete next[draftId];
        return next;
      });

      try {
        const res = await fetch('/api/bulk-ai/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draftId, overrides }),
        });
        const body = await res.json();

        if (res.ok && body.ok) {
          const masterSku: string | null = body.data.masterSku ?? null;
          const alreadyRecovered: boolean = !!body.data.alreadyRecovered;
          // Remove the draft + decrement total EXACTLY once (idempotent reducer).
          setItems((prevItems) => {
            const st = applyRecoverySuccess({ items: prevItems, total }, draftId);
            setTotal(st.total);
            return st.items;
          });
          setToast({ masterSku, alreadyRecovered });
        } else {
          setCardErrors((prev) => ({ ...prev, [draftId]: recoveryErrorMessage(body?.error?.code) }));
        }
      } catch {
        setCardErrors((prev) => ({ ...prev, [draftId]: recoveryErrorMessage(undefined, { isNetwork: true }) }));
      } finally {
        // Release the lock on EVERY path (success / API error / network error).
        busyRef.current.delete(draftId);
        setBusyIds(new Set(busyRef.current));
      }
    },
    [total],
  );

  // ─── Pagination ─────────────────────────────────────────────────────────────
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Success toast (announced to screen readers) */}
      <div aria-live="polite" className="sr-only">
        {toast && (toast.alreadyRecovered ? 'Draft was already recovered' : 'Product recovered')}
      </div>
      {toast && (
        <div className="rounded-lg border border-green-600/40 bg-green-600/10 text-green-800 dark:text-green-300 p-3 text-sm flex items-center justify-between gap-3">
          <span>
            <span aria-hidden="true">✓ </span>
            {toast.alreadyRecovered
              ? 'This draft was already recovered.'
              : 'Product recovered successfully.'}
            {toast.masterSku && (
              <>
                {' '}
                <Link href={productHref(toast.masterSku)} className="font-medium underline hover:opacity-80">
                  View {toast.masterSku} →
                </Link>
              </>
            )}
          </span>
          <button type="button" onClick={() => setToast(null)} className="text-xs hover:underline">
            dismiss
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {loading ? 'Loading…' : `${total} draft${total === 1 ? '' : 's'} awaiting recovery`}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void load(offset)} disabled={loading}>
            ↻ Refresh
          </Button>
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <Card key={i} className="!p-4">
              <div className="animate-pulse space-y-3">
                <div className="flex gap-4">
                  <div className="w-24 h-24 rounded-md bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded w-2/3" />
                    <div className="h-3 bg-muted rounded w-1/3" />
                  </div>
                </div>
                <div className="h-16 bg-muted rounded" />
                <div className="h-24 bg-muted rounded" />
              </div>
            </Card>
          ))}
        </div>
      ) : loadError ? (
        <Card className="text-center py-12 space-y-3">
          <p role="alert" className="text-sm text-destructive">
            <span aria-hidden="true">⚠ </span>{loadError}
          </p>
          <Button type="button" onClick={() => void load(offset)}>Retry</Button>
        </Card>
      ) : items.length === 0 ? (
        <Card className="text-center py-12 text-muted-foreground">
          No drafts need recovery.
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((draft) => (
            <RecoveryDraftCard
              key={draft.id}
              draft={draft}
              brands={brands}
              categories={categories}
              subcategories={subcategories}
              busy={busyIds.has(draft.id)}
              error={cardErrors[draft.id] ?? null}
              onRecover={recover}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && !loadError && total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canPrev}
            onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!canNext}
            onClick={() => void load(offset + PAGE_SIZE)}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}
