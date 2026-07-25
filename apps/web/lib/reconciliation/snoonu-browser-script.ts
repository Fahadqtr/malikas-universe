/**
 * Snoonu Seller Portal — READ-ONLY browser extractor script.
 *
 * Source of truth for the JS that runs inside Chrome (via the Claude-in-Chrome
 * MCP `javascript_tool`) when auditing Snoonu product detail pages. The script
 * is exported as a string so it can be:
 *   1. Pasted into `javascript_tool` calls during batch audits
 *   2. Versioned + linted + unit-tested in this repo
 *   3. Updated in one place when Snoonu's portal layout changes
 *
 * SAFETY (enforced inside the script):
 *   - Verifies `location.href` matches a product detail/edit URL before
 *     reading anything. If not, returns { ok: false, reason: 'not_on_product_detail_page' }.
 *   - Scopes ALL tab queries to the inner product-form tablist. Never touches
 *     the outer Catalog tabs (the top-level portal navigation).
 *   - After every tab click, re-checks the URL. If we navigated away, stops
 *     and reports `navigated_away_after_<x>_tab_click`.
 *   - Never clicks Save, Submit, Publish, Update Stock, Update Status, or
 *     Update Price. Only clicks the three inner tabs (General Details /
 *     Availability & Price / Choice Groups).
 *
 * Phase 13E.17.
 */

// ─── Result shape ───────────────────────────────────────────────────────────

export type SnoonuPageExtractOk = {
  ok: true;
  snoonu_id: string | null;
  url: string;
  name: string | null;
  name_ar: string | null;
  sku: string | null;
  barcode: string | null;
  image: string | null;
  listed_categories: string[];
  branches: Array<{
    name: string;
    stock: number;
    price: number | null;
    available: boolean;
  }>;
  has_options: boolean;
  option_groups: Array<unknown>;
};

export type SnoonuPageExtractFail = {
  ok: false;
  reason:
    | 'not_on_product_detail_page'
    | 'inner_tablist_not_found'
    | 'navigated_away_after_general_tab_click'
    | 'navigated_away_after_availability_tab_click'
    | 'navigated_away_after_choice_tab_click';
  url: string;
  partial?: {
    snoonu_id?: string | null;
    name?: string | null;
    image?: string | null;
    listed_categories?: string[];
    branches?: Array<unknown>;
  };
};

export type SnoonuPageExtractResult = SnoonuPageExtractOk | SnoonuPageExtractFail;

// ─── The script ─────────────────────────────────────────────────────────────
//
// IMPORTANT: keep this string a SELF-CONTAINED async IIFE. The Chrome MCP
// `javascript_tool` evaluates the expression and returns the last value (or
// the resolved Promise's value). We return a JSON string from the IIFE so
// Chrome shows it nicely and we can parse it back on the caller side.
//
// All four safety fixes are tagged with [FIX N] comments below.

export const SNOONU_EXTRACTOR_JS = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // [FIX 1] Verify we're on a product detail/edit page before reading
  // anything. Snoonu's edit URL pattern is /v2/dashboard/catalog/product/edit/<24-hex>.
  // If we're on /catalog (the list view) or anywhere else, abort.
  function onProductPage() {
    return /\/product\/(edit|view|detail)\/[a-f0-9]{8,}/i.test(location.href);
  }
  if (!onProductPage()) {
    return JSON.stringify({
      ok: false,
      reason: 'not_on_product_detail_page',
      url: location.href,
    });
  }

  const snoonu_id = location.href.match(/\/product\/(?:edit|view|detail)\/([a-f0-9]+)/i)?.[1] ?? null;

  // [FIX 2] Scope tab queries to the INNER product-form tablist only.
  // The catalog page has its OWN outer [role=tablist] (the top-level portal
  // navigation). A global, unscoped tab query would match those outer tabs
  // too, and we may click the wrong one — which is exactly the bug that
  // surfaced during the first batch-50 run.
  //
  // Strategy: find the tablist whose tabs include "General Details" — that's
  // unambiguously the inner product form tablist.
  function findInnerTablist() {
    // Strategy A: aria-label hint ("Category form tabs" on current Snoonu UI)
    const byLabel = document.querySelector(
      '[role=tablist][aria-label*="form" i], [role=tablist][aria-label*="product" i]'
    );
    if (byLabel) {
      const tabs = Array.from(byLabel.querySelectorAll('[role=tab]'));
      if (tabs.some((t) => /general details/i.test(t.textContent || ''))) return byLabel;
    }
    // Strategy B: scan all tablists, pick the one containing "General Details"
    const all = Array.from(document.querySelectorAll('[role=tablist]'));
    for (const tl of all) {
      const tabs = Array.from(tl.querySelectorAll('[role=tab]'));
      if (tabs.some((t) => /general details/i.test(t.textContent || ''))) return tl;
    }
    return null;
  }

  const innerTablist = findInnerTablist();
  if (!innerTablist) {
    return JSON.stringify({
      ok: false,
      reason: 'inner_tablist_not_found',
      url: location.href,
    });
  }

  // Always look for tabs INSIDE the inner tablist. This guarantees we
  // never accidentally click the outer Catalog tabs.
  function innerTab(labelRegex) {
    const re = new RegExp(labelRegex, 'i');
    return Array.from(innerTablist.querySelectorAll('[role=tab]')).find((t) =>
      re.test(t.textContent || '')
    );
  }

  // [FIX 4] URL guard — call after every tab click. If we navigated off the
  // product edit page (e.g. due to a misfired click on an outer tab), stop
  // immediately and return what we already have.
  function checkStillOnPage(afterClick) {
    if (!onProductPage()) {
      throw Object.assign(new Error('navigated_away'), {
        __exit: {
          ok: false,
          reason: 'navigated_away_after_' + afterClick + '_tab_click',
          url: location.href,
        },
      });
    }
  }

  try {
    // ─── Tab 1: General Details ───────────────────────────────────────
    const genTab = innerTab('General Details');
    if (genTab) {
      genTab.click();
      await sleep(1500);
      checkStillOnPage('general');
    }

    const inputs = Array.from(document.querySelectorAll('input, textarea')).reduce(
      (acc, i) => {
        const k = i.getAttribute('aria-label') || i.getAttribute('placeholder') || i.name;
        if (k && i.value && String(i.value).trim()) acc[k] = String(i.value).trim();
        return acc;
      },
      {}
    );

    const image =
      Array.from(document.querySelectorAll('img')).find((i) =>
        i.src && i.src.includes('snoonu') && i.src.includes('product')
      )?.src ?? null;

    const catsLine = document.body.innerText.match(
      /Listed in the categor(?:y|ies):\s*([^\n]+)/
    );
    const listed_categories = catsLine
      ? catsLine[1].trim().split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean)
      : [];

    // ─── Tab 2: Availability & Price ──────────────────────────────────
    const availTab = innerTab('Availability');
    let branches = [];
    if (availTab) {
      availTab.click();
      await sleep(2000);
      checkStillOnPage('availability');

      const m = document.body.innerText.match(
        /Branch\s+Stock QTY\s+Price\s+Availability\s+([\s\S]+?)(?:Previous Step|Next Step)/
      );
      if (m) {
        const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
        let i = 0;
        while (i < lines.length) {
          const name = lines[i];
          if (!name || /^\d+$/.test(name)) {
            i++;
            continue;
          }
          const stock = parseInt(lines[i + 1], 10);
          if (!isNaN(stock)) {
            const price = parseFloat(lines[i + 2]);
            branches.push({
              name,
              stock,
              price: isNaN(price) ? null : price,
              available: lines[i + 3] === 'Available',
            });
            i += 4;
          } else {
            i++;
          }
        }
      }
    }

    // ─── Tab 3: Choice Groups ─────────────────────────────────────────
    const choiceTab = innerTab('Choice Groups');
    let has_options = false;
    const option_groups = [];
    if (choiceTab) {
      choiceTab.click();
      await sleep(1500);
      checkStillOnPage('choice');

      const choiceText = document.body.innerText;
      has_options = !/Select choice groups or add-ons to show with this menu item\s*Add Choice Group/.test(
        choiceText
      );
      // TODO Phase 13E.18: parse option group rows when present.
    }

    return JSON.stringify({
      ok: true,
      snoonu_id,
      url: location.href,
      name: inputs['Name'] ?? null,
      name_ar: inputs['اسم العنصر'] ?? null,
      sku: (inputs['SKU'] ?? '').trim() || null,
      barcode: (inputs['Barcode'] ?? '').trim() || null,
      image,
      listed_categories,
      branches,
      has_options,
      option_groups,
    });
  } catch (e) {
    if (e && e.__exit) return JSON.stringify(e.__exit);
    return JSON.stringify({
      ok: false,
      reason: 'extractor_threw',
      url: location.href,
      message: String(e && e.message ? e.message : e),
    });
  }
})()`;

// ─── Caller-side helper ─────────────────────────────────────────────────────

/**
 * Convert an `ok: true` extractor result into the snapshot shape that
 * `/api/snoonu-browser-audit/save-from-browser` expects.
 */
export function extractorResultToSnapshot(
  res: SnoonuPageExtractOk,
): Record<string, unknown> {
  return {
    page_url: res.url,
    page_title: 'Edit Product | Snoonu Portal',
    product_id_field: res.snoonu_id,
    product_name_field: res.name,
    product_name_ar_field: res.name_ar,
    catalog_field: res.listed_categories[0] ?? null,
    category_field: res.listed_categories[0] ?? null,
    listed_categories: res.listed_categories,
    branches: res.branches,
    image_url_field: res.image,
    option_groups_raw: res.option_groups,
    // status derived server-side from branches.available[]
  };
}

/**
 * Compact one-line summary of what was extracted — for log lines in the
 * batch run report.
 */
export function summarizeExtract(res: SnoonuPageExtractResult): string {
  if (!res.ok) return `❌ ${res.reason} @ ${res.url}`;
  const cat = res.listed_categories.length > 1
    ? `[${res.listed_categories.join(' | ')}]`
    : (res.listed_categories[0] ?? '?');
  const stock = res.branches.reduce((acc, b) => acc + (b.stock ?? 0), 0);
  const price = res.branches[0]?.price ?? null;
  const opts = res.has_options ? ' · ⚙ options' : '';
  return `✅ ${res.name} · ${cat} · ${price ?? '?'} QAR · stock ${stock}${opts}`;
}
