'use client';

/**
 * ReadinessPanel — sidebar widget on /products/[sku].
 * Shows readiness for all 4 marketplaces with tab switcher.
 *
 * The validator is pure JS so we compute all 4 targets in-process —
 * no extra fetches.
 */

import { useState } from 'react';
import { checkReadiness, type MarketplaceTarget, type ProductForReadiness } from '@/lib/readiness';
import { ReadinessBar, ReadinessIssuesList } from '@/components/readiness-badge';

const TARGETS: { id: MarketplaceTarget; label: string }[] = [
  { id: 'shopify', label: 'Shopify' },
  { id: 'snoonu', label: 'Snoonu' },
  { id: 'talabat', label: 'Talabat' },
  { id: 'rafeeq', label: 'Rafeeq' },
];

export function ReadinessPanel({ product }: { product: ProductForReadiness }) {
  const [active, setActive] = useState<MarketplaceTarget>('shopify');
  const result = checkReadiness(product, active);

  return (
    <div className="space-y-3">
      {/* Tabs */}
      <div className="flex rounded-md border border-border overflow-hidden text-xs">
        {TARGETS.map((t) => {
          const r = checkReadiness(product, t.id);
          const dot =
            r.score >= 90 ? 'bg-green-600' : r.score >= 70 ? 'bg-yellow-500' : 'bg-red-600';
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={`flex-1 px-2 py-1.5 font-medium border-l first:border-l-0 border-border flex items-center justify-center gap-1.5
                ${active === t.id ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'}
              `}
            >
              <span className={`w-2 h-2 rounded-full ${dot}`} />
              {t.label}
            </button>
          );
        })}
      </div>

      <ReadinessBar
        score={result.score}
        ready={result.ready}
        target={active}
        error_count={result.error_count}
        warning_count={result.warning_count}
      />

      <ReadinessIssuesList issues={result.issues} />
    </div>
  );
}
