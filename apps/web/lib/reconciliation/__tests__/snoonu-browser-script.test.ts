/**
 * Drift guard for the Snoonu browser extractor script.
 *
 * Asserts that:
 *   1. The script string is syntactically valid JavaScript
 *   2. It contains every required safety check (URL guard, scoped tabs,
 *      post-click re-check)
 *   3. It NEVER references outer-catalog tab labels in a click context
 */

import { describe, it, expect } from 'vitest';
import {
  SNOONU_EXTRACTOR_JS,
  extractorResultToSnapshot,
  summarizeExtract,
  type SnoonuPageExtractOk,
} from '../snoonu-browser-script';

describe('SNOONU_EXTRACTOR_JS', () => {
  it('is syntactically valid JavaScript', () => {
    // Wrapped in a function expression so we can parse without executing.
    expect(() => new Function(`return ${SNOONU_EXTRACTOR_JS};`)).not.toThrow();
  });

  it('verifies product detail URL before extracting (FIX 1)', () => {
    expect(SNOONU_EXTRACTOR_JS).toContain('not_on_product_detail_page');
    expect(SNOONU_EXTRACTOR_JS).toMatch(/\/product\\\/\(edit\|view\|detail\)/);
  });

  it('uses a scoped tablist selector — never global [role=tab] for clicks (FIX 2)', () => {
    // The script must define a scoped innerTablist before ever clicking a tab.
    expect(SNOONU_EXTRACTOR_JS).toContain('findInnerTablist');
    expect(SNOONU_EXTRACTOR_JS).toContain('innerTablist.querySelectorAll');
    expect(SNOONU_EXTRACTOR_JS).toContain('inner_tablist_not_found');

    // No raw document-wide tab click pattern. We allow `document.querySelectorAll('[role=tablist]')`
    // (used to FIND the inner one) but never `document.querySelectorAll('[role=tab]')` followed
    // by a click.
    const lines = SNOONU_EXTRACTOR_JS.split('\n');
    for (const line of lines) {
      const matches = line.includes("document.querySelectorAll('[role=tab]')") ||
                      line.includes('document.querySelectorAll("[role=tab]")');
      expect(matches).toBe(false);
    }
  });

  it('checks URL after every tab click (FIX 4)', () => {
    expect(SNOONU_EXTRACTOR_JS).toContain('checkStillOnPage');
    expect(SNOONU_EXTRACTOR_JS).toContain("checkStillOnPage('general')");
    expect(SNOONU_EXTRACTOR_JS).toContain("checkStillOnPage('availability')");
    expect(SNOONU_EXTRACTOR_JS).toContain("checkStillOnPage('choice')");
    expect(SNOONU_EXTRACTOR_JS).toContain('navigated_away_after_');
  });

  it('never clicks Save / Submit / Publish / Update buttons (read-only invariant)', () => {
    // The script's only click calls should be on tab elements obtained via innerTab().
    const forbidden = [
      /\.click\(\)/g,
    ];
    // Count total click() calls and verify they're all preceded by innerTab(.
    // We scan for click() and look back ~80 chars; each must be in genTab/availTab/choiceTab context.
    const clickMatches = [...SNOONU_EXTRACTOR_JS.matchAll(/(\w+)\.click\(\)/g)];
    const allowedReceivers = new Set(['genTab', 'availTab', 'choiceTab']);
    for (const m of clickMatches) {
      // Regex `/(\w+)\.click\(\)/g` always captures group 1 on a match.
      expect(allowedReceivers.has(m[1]!)).toBe(true);
    }
    void forbidden;
  });

  it('does not reference outer-catalog-only tabs (Overview, Drafts & Approvals)', () => {
    // These labels are only on the outer catalog page tabs. The script's
    // innerTab() is scoped, but as defense-in-depth we ensure no string
    // literal mentions them.
    expect(SNOONU_EXTRACTOR_JS).not.toContain('Overview');
    expect(SNOONU_EXTRACTOR_JS).not.toContain('Drafts');
  });

  it('returns valid JSON shape (ok=true path)', () => {
    // The script builds its result with `JSON.stringify({ ok: true, ... })`, so
    // the source contains the unquoted object literal `ok: true` (matching the
    // `ok: false` failure-path convention asserted below), not a quoted key.
    expect(SNOONU_EXTRACTOR_JS).toContain('ok: true');
    expect(SNOONU_EXTRACTOR_JS).toContain('snoonu_id');
    expect(SNOONU_EXTRACTOR_JS).toContain('listed_categories');
    expect(SNOONU_EXTRACTOR_JS).toContain('branches');
    expect(SNOONU_EXTRACTOR_JS).toContain('has_options');
  });

  it('exits cleanly on every failure mode', () => {
    expect(SNOONU_EXTRACTOR_JS).toContain('extractor_threw');
    // Failure paths all return JSON with ok:false + reason:
    expect(SNOONU_EXTRACTOR_JS).toMatch(/ok:\s*false,\s*reason:/g);
  });
});

describe('extractorResultToSnapshot', () => {
  it('maps single-category extraction correctly', () => {
    const result: SnoonuPageExtractOk = {
      ok: true,
      snoonu_id: 'abc123',
      url: 'https://snoonu-portal.snoonu.com/v2/dashboard/catalog/product/edit/abc123',
      name: 'Foo Product',
      name_ar: 'فو',
      sku: null,
      barcode: null,
      image: 'https://images.snoonu.com/product/2025/x.jpg',
      listed_categories: ['Electronics'],
      branches: [{ name: 'Ali Bin Abdullah Street', stock: 10, price: 89, available: true }],
      has_options: false,
      option_groups: [],
    };
    const snap = extractorResultToSnapshot(result) as Record<string, unknown>;
    expect(snap.product_name_field).toBe('Foo Product');
    expect(snap.product_name_ar_field).toBe('فو');
    expect(snap.catalog_field).toBe('Electronics');
    expect(snap.listed_categories).toEqual(['Electronics']);
    expect((snap.branches as unknown[]).length).toBe(1);
  });

  it('maps multi-category extraction with primary preserved', () => {
    const result: SnoonuPageExtractOk = {
      ok: true,
      snoonu_id: 'def456',
      url: 'https://snoonu-portal.snoonu.com/v2/dashboard/catalog/product/edit/def456',
      name: 'Bar Cross-Listed',
      name_ar: null,
      sku: null,
      barcode: null,
      image: null,
      listed_categories: ['Beauty Accessories', 'Face Care'],
      branches: [],
      has_options: false,
      option_groups: [],
    };
    const snap = extractorResultToSnapshot(result) as Record<string, unknown>;
    expect(snap.catalog_field).toBe('Beauty Accessories');
    expect(snap.listed_categories).toEqual(['Beauty Accessories', 'Face Care']);
  });
});

describe('summarizeExtract', () => {
  it('produces a one-line success summary for single category', () => {
    const r: SnoonuPageExtractOk = {
      ok: true, snoonu_id: 'x', url: 'x', name: 'Test', name_ar: null, sku: null, barcode: null,
      image: null, listed_categories: ['Hair Care'],
      branches: [{ name: 'B1', stock: 5, price: 49, available: true }],
      has_options: false, option_groups: [],
    };
    const s = summarizeExtract(r);
    expect(s).toContain('✅');
    expect(s).toContain('Test');
    expect(s).toContain('Hair Care');
    expect(s).toContain('49');
    expect(s).toContain('stock 5');
  });

  it('shows cross-list marker for multi-category', () => {
    const r: SnoonuPageExtractOk = {
      ok: true, snoonu_id: 'x', url: 'x', name: 'Brush', name_ar: null, sku: null, barcode: null,
      image: null, listed_categories: ['Beauty Accessories', 'Face Care'],
      branches: [], has_options: false, option_groups: [],
    };
    const s = summarizeExtract(r);
    expect(s).toContain('[Beauty Accessories | Face Care]');
  });
});
