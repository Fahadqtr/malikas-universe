/**
 * Snoonu Catalog Section Page — READ-ONLY browser extractor.
 *
 * Phase 13F.5. JS string that runs inside Chrome (via the Claude-in-Chrome
 * MCP `javascript_tool`) when scraping a Snoonu catalog section page.
 *
 * Returns:
 *   {
 *     ok: true,
 *     section_name: string | null,    // page title or category header
 *     source_url: string,
 *     pages_scanned: number,          // number of paginated pages we read
 *     products: Array<{
 *       spi: string | null,           // 24-hex from /product/edit/<id> in row anchor
 *       name: string,
 *       price: number | null,
 *       image_url: string | null,
 *     }>,
 *     duplicates: number,
 *   }
 *
 *   On failure:
 *   { ok: false, reason, url }
 *
 * SAFETY (enforced inside the script):
 *   - NEVER clicks Save / Edit / Delete / Update Status / Update Price
 *   - NEVER opens any product detail page
 *   - NEVER modifies any row
 *   - Reads-only: querySelectorAll + textContent + getAttribute
 *
 * The script auto-paginates by clicking "Next" if and only if the button is
 * the "Next page" pagination control in the catalog list. To stay defensive
 * we cap pagination at MAX_PAGES to avoid infinite loops.
 */

export type SnoonuSectionExtractOk = {
  ok: true;
  section_name: string | null;
  source_url: string;
  pages_scanned: number;
  products: Array<{
    spi: string | null;
    name: string;
    price: number | null;
    image_url: string | null;
  }>;
  duplicates: number;
};

export type SnoonuSectionExtractFail = {
  ok: false;
  reason:
    | 'not_on_catalog_page'
    | 'no_product_rows_found'
    | 'extractor_threw';
  url: string;
  message?: string;
};

export type SnoonuSectionExtractResult = SnoonuSectionExtractOk | SnoonuSectionExtractFail;

export const SNOONU_SECTION_EXTRACTOR_JS = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // We're allowed on the catalog list view OR on a category-filtered catalog
  // list. Both URLs include /dashboard/catalog (with or without query string).
  function onCatalogListPage() {
    return /\/dashboard\/catalog(\b|\?|$)/i.test(location.href) &&
           !/\/product\/(edit|view|detail)\//i.test(location.href);
  }
  if (!onCatalogListPage()) {
    return JSON.stringify({ ok: false, reason: 'not_on_catalog_page', url: location.href });
  }

  // Try to detect the section name from the page heading. The catalog page
  // typically shows the currently-filtered category as a heading or chip.
  function detectSectionName() {
    // Try common headings
    const candidates = [
      'h1', 'h2', 'h3',
      '[role=heading]',
      '.chakra-heading',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length < 60) {
        const t = el.textContent.trim();
        if (!/^(Catalog|Products|Search|Dashboard)$/i.test(t)) return t;
      }
    }
    // Fallback: try URL search/category param
    const params = new URLSearchParams(location.search);
    return params.get('category') || params.get('section') || null;
  }

  // Extract one page worth of product rows. Strategy: find every <a> whose
  // href points to /product/edit/<24-hex>, then walk up to its row container
  // to read the product name + price + image.
  function extractPage() {
    const seen = new Set();
    const out = [];
    let duplicates = 0;

    const links = document.querySelectorAll('a[href*="/product/edit/"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/product\/(?:edit|view|detail)\/([a-f0-9]{8,})/i);
      const spi = m ? m[1] : null;
      const row = a.closest('tr, [role=row], li, .product-row, .product-card') || a.parentElement;
      if (!row) continue;
      const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim();

      // Name = the longest text in the row that doesn't look like a price/SKU/qty
      let name = (a.textContent || '').trim();
      if (!name || name.length < 3) {
        // Look at any text element inside the row that isn't a number/price
        const texts = Array.from(row.querySelectorAll('span, p, td, div'))
          .map((e) => (e.textContent || '').trim())
          .filter((t) => t && t.length >= 3 && !/^QAR|^\d+(\.\d+)?$/.test(t));
        if (texts.length > 0) {
          // Pick the longest non-numeric text
          name = texts.sort((a, b) => b.length - a.length)[0];
        }
      }
      if (!name) continue;

      // Price detection: look for "QAR <n>" or pure numbers in price-ish positions
      let price = null;
      const priceMatch = rowText.match(/QAR\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*QAR/);
      if (priceMatch) price = parseFloat(priceMatch[1] || priceMatch[2]);

      // Image: first <img> inside the row
      const imgEl = row.querySelector('img');
      const image_url = imgEl ? imgEl.src : null;

      // Dedup by SPI if available, else by name
      const key = spi || name.toLowerCase();
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      out.push({ spi, name, price, image_url });
    }
    return { products: out, duplicates };
  }

  // Find the Next-page button (case-insensitive) within pagination controls.
  function findNextButton() {
    const cands = Array.from(document.querySelectorAll('button, a'));
    for (const b of cands) {
      const text = (b.textContent || '').trim().toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      if (
        (text === 'next' || text === 'next page' || aria === 'next page' || aria === 'next' || aria === 'go to next page') &&
        !b.hasAttribute('disabled') &&
        !b.getAttribute('aria-disabled')
      ) {
        return b;
      }
    }
    return null;
  }

  const MAX_PAGES = 30;
  const allProducts = [];
  const seenGlobal = new Set();
  let totalDuplicates = 0;
  let pages_scanned = 0;
  const section_name = detectSectionName();

  try {
    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      // Wait for any in-flight render to settle
      await sleep(800);
      const { products, duplicates } = extractPage();
      pages_scanned++;
      totalDuplicates += duplicates;

      // Merge into global, dedupe
      for (const p of products) {
        const key = p.spi || p.name.toLowerCase();
        if (seenGlobal.has(key)) {
          totalDuplicates++;
          continue;
        }
        seenGlobal.add(key);
        allProducts.push(p);
      }

      const nextBtn = findNextButton();
      if (!nextBtn) break;
      nextBtn.click();
      await sleep(1500);
      if (!onCatalogListPage()) break; // safety: bail if navigation drifted
    }

    if (allProducts.length === 0) {
      return JSON.stringify({
        ok: false,
        reason: 'no_product_rows_found',
        url: location.href,
      });
    }

    return JSON.stringify({
      ok: true,
      section_name,
      source_url: location.href,
      pages_scanned,
      products: allProducts,
      duplicates: totalDuplicates,
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      reason: 'extractor_threw',
      url: location.href,
      message: String(e && e.message ? e.message : e),
    });
  }
})()`;

// ─── Section registry ──────────────────────────────────────────────────────

/**
 * Known Snoonu catalog section names. Used by the UI to drive scrape
 * orchestration. URLs are added when we have them — otherwise the operator
 * navigates manually.
 */
export const SNOONU_KNOWN_SECTIONS = [
  'Hair Care',
  'Face Care',
  'Sun Protection',
  'Masks',
  'Body Care',
  'Dental Care',
  'Beauty Accessories',
  'Beauty Bundle',
  'Makeup',
  'Lashes & Nails',
  'Electronics',
  'Rhode Products Section',
  'Gifts & Special Occasions',
  'Thailand Products',
  'Toys',
  "Women's Essentials",
  'Eid Specials',
] as const;
