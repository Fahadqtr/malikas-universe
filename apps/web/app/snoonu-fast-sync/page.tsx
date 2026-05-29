/**
 * /snoonu-fast-sync
 *
 * Phase 13F. Faster Snoonu reconciliation path using the official Snoonu
 * Seller Portal xlsx export.
 *
 *   1. Upload xlsx → inspect column structure (READ-ONLY)
 *   2. Apply export to platform_products (price, stock, branches, name)
 *   3. Scrape catalog section pages → set catalog/category per product
 *   4. Rebuild audit queue with only the truly uncertain products
 *
 * This page is the orchestrator UI. Each step is a separate API call.
 */

import { FastSyncClient } from './fast-sync-client';
import { SectionScraperPanel } from './section-scraper-panel';

export const metadata = {
  title: 'Snoonu Fast Sync',
};

export default function Page() {
  return (
    <div className="px-6 py-6 max-w-5xl space-y-10">
      <header>
        <h1 className="text-2xl font-semibold mb-1">Snoonu Fast Sync</h1>
        <p className="text-sm text-zinc-500">
          Skip per-product browser audits. Import the Snoonu xlsx export, map
          catalogs by scraping section pages, and audit only the leftover
          uncertain products.
        </p>
      </header>

      <FastSyncClient />

      <div id="catalog" />
      <SectionScraperPanel />
    </div>
  );
}
