# Snoonu Browser Audit — Batch Runbook

**Purpose:** Process the audit queue at `/snoonu-browser-audit` against the live
Snoonu Seller Portal in batches of N (typically 50). READ-ONLY in Snoonu.

## Prerequisites

1. Migrations 0018, 0019, 0020, 0021 applied
2. User logged into `snoonu-portal.snoonu.com` in the same Chrome profile MCP is attached to
3. `Claude in Chrome` extension connected and tab group ready
4. Audit queue populated — click **🔄 Rebuild audit queue** on `/snoonu-browser-audit`

## Safety rules — READ-ONLY in Snoonu

Encoded in `apps/web/lib/reconciliation/snoonu-browser-script.ts` and enforced
by `apps/web/lib/reconciliation/__tests__/snoonu-browser-script.test.ts`.

| Rule | Enforcement |
|---|---|
| Never click Save / Submit / Publish / Update Stock / Update Status / Update Price | The extractor script only calls `.click()` on `genTab`/`availTab`/`choiceTab` references — vitest verifies this |
| Verify we're on a product detail page before extracting | `[FIX 1]` — URL regex check; aborts with `not_on_product_detail_page` |
| Scope tab clicks to the inner product-form tablist | `[FIX 2]` — `findInnerTablist()` finds the tablist containing "General Details", never the outer Catalog tabs |
| Recheck URL after every tab click | `[FIX 4]` — `checkStillOnPage()` throws `navigated_away_after_<x>_tab_click` if we drift off |
| Never click outer Catalog tabs | All tab queries go through `innerTab()`, which is scoped to `innerTablist` |

## Per-product flow (Chrome MCP)

For each audit row from `POST /api/snoonu-browser-audit/next-batch`:

1. **Reset page**: `navigate` to `https://snoonu-portal.snoonu.com/v2/dashboard/catalog`,
   `wait 3s`, `find` the search input
2. **Search**: `form_input` the search box with the queue product name (use first
   3–4 words to avoid over-narrow queries)
3. **Find Edit**: `find` for "first product row Edit pencil button"
4. **Open detail**: `left_click` on the Edit ref, `wait 5s`
5. **Extract**: call `javascript_tool` with `SNOONU_EXTRACTOR_JS` (the constant
   from `lib/reconciliation/snoonu-browser-script.ts`). The script returns a
   JSON string with `ok: true | false`.
6. **Branch on result**:
   - `ok: false` → mark audit `error` or `needs_review` via
     `PATCH /api/snoonu-browser-audit/[id]` with action `mark_error` and notes
     containing the reason. Skip to next product.
   - `ok: true` → convert via `extractorResultToSnapshot()` and POST to
     `/api/snoonu-browser-audit/save-from-browser` with `product_id` from the
     batch row. Endpoint validates name similarity + price match and:
       - confidence ≥ 0.95 → save + auto-apply
       - 0.75–0.95 → save as `audited` (operator review)
       - < 0.75 → save as `needs_review`

## Stop conditions (abort the batch immediately)

- Login challenge appears (URL contains `/login` or `/auth`)
- Three consecutive "product not found" results in a row
- Three consecutive `not_on_product_detail_page` extractor results
- Network or Supabase error count exceeds 5 in the current batch

## Final report (after batch ends, normal or aborted)

Generate:

```
Batch 50 — N products processed

found        : N    (Snoonu had the product)
not_found    : N    (search returned no match)
auto_applied : N    (confidence ≥ 0.95)
needs_review : N    (confidence 0.75–0.95 or extractor partial)
errors       : N    (any failure path)
options      : N    (has_options=true)
multi_cat    : N    (listed_categories.length > 1)
```

Plus a per-product CSV-style log showing audit_id, name, listed_categories,
branches summary, confidence, final audit_status.

## When to update the extractor

If Snoonu's portal layout changes (new tab name, different aria-label, etc):

1. Update `SNOONU_EXTRACTOR_JS` in `apps/web/lib/reconciliation/snoonu-browser-script.ts`
2. Run the vitest suite: `pnpm test snoonu-browser-script`
3. The drift guard tests will fail if any of the 4 safety invariants are removed
4. Test on a single product before running another batch
