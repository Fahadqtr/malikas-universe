# Snoonu Catalog Mapper — Browser-Read Flow (READ-ONLY)

**Phase 13D.5** — how to safely read catalog info from the Snoonu seller portal
without ever writing back to Snoonu.

## Safety contract

These rules apply for the entire lifetime of this feature. Violation is a
production incident.

| Allowed | Forbidden |
|---|---|
| `read_page` — extract DOM text/structure | `left_click` on Save / Submit / Publish / Delete / Edit / Apply |
| `get_page_text` | `form_input` on any field that's part of an edit form |
| `read_console_messages` | `javascript_tool` that triggers a save action |
| `tabs_context_mcp` to enumerate open tabs | `navigate` to a destructive URL (e.g. `?action=delete`) |
| `find` for breadcrumb / category / section selectors | Any keyboard input on a focused form field |

If a Snoonu page has a "Save" button visible while we're reading, the read
must complete without touching it. If a JavaScript handler on the page
auto-fires a save on click of any element, do not click anything — only
extract text via `read_page` / `get_page_text`.

## What we extract

For each Snoonu product detail / edit page:

```json
{
  "breadcrumb": ["Beauty", "Skincare", "Korean Skincare"],
  "menu_label": "Beauty",
  "category_field_value": "Skincare",
  "subcategory_field_value": "Korean Skincare",
  "section_label": "Featured",
  "collection_label": "Bestsellers",
  "page_url": "https://merchant.snoonu.com/products/12345"
}
```

Any field may be null — the parser handles missing data.

## Operator flow

1. Open `/snoonu-catalog-mapper` in our admin app
2. Pick the Snoonu import to map
3. Filter to `Missing catalog`
4. For each row in the filtered list:
   - Click "✏️ Paste from Snoonu" (or, when implemented, "Read from browser tab")
   - In the **other** Chrome tab where you have the Snoonu seller portal open,
     navigate to that product's detail page (do NOT click Edit — only view)
   - **Option A (manual)** — copy the breadcrumb visible at the top of the
     Snoonu page, paste into our modal, save
   - **Option B (browser_blob)** — use the Chrome MCP "Read catalog from current
     tab" action. The extension reads the page text, identifies the
     breadcrumb / category selectors, and POSTs the blob to our API
5. Our `/set` endpoint receives the blob, parses it via `parseFromBrowserDom()`,
   and writes to `platform_products`

## Browser-blob payload via Chrome MCP

When the operator clicks "Read catalog from current tab" the client should
trigger a Chrome MCP `read_page` call against the active Snoonu tab. The
extracted text is then mapped to the `BrowserDomBlob` shape and POSTed:

```http
POST /api/snoonu-catalog-mapper/set
Content-Type: application/json

{
  "row_id": 12345,
  "browser_blob": {
    "breadcrumb": ["Beauty", "Skincare", "Korean Skincare"],
    "menu_label": "Beauty",
    "category_field_value": "Skincare",
    "subcategory_field_value": "Korean Skincare",
    "section_label": null,
    "collection_label": null,
    "page_url": "https://merchant.snoonu.com/products/12345"
  }
}
```

The server projects this through `parseFromBrowserDom()` and writes the
resulting `CatalogMapping` to the row. `catalog_source = 'browser_read'`.

## Pilot checklist (first 10 products)

1. Apply migration 0018 in Supabase SQL Editor
2. Restart dev server
3. Open `/snoonu-catalog-mapper`
4. Pick your most recent Snoonu import
5. Click "Auto-map from export columns" — fills in any rows where the export
   already has Menu Category / Sub Category columns
6. Look at the **Missing catalog** filter to see what's still uncategorized
7. For each of the first 10 missing rows:
   - Open the Snoonu seller portal in another tab
   - Find the matching product (search by SKU or name)
   - Open the product detail/edit page **without clicking any save buttons**
   - Copy the breadcrumb or category field value
   - Paste it via the "✏️ Paste from Snoonu" button in our app
   - Verify the row now shows the catalog path
8. After 10 successful mappings, export the CSV and review
9. Scale to 50 → 100 → all

## Verification queries

```sql
-- Count Snoonu rows by catalog mapping status for this import
SELECT
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE snoonu_category IS NOT NULL) AS mapped,
  COUNT(*) FILTER (WHERE snoonu_category IS NULL) AS missing,
  COUNT(*) FILTER (WHERE catalog_source = 'export_column') AS via_export,
  COUNT(*) FILTER (WHERE catalog_source = 'manual_paste') AS via_paste,
  COUNT(*) FILTER (WHERE catalog_source = 'browser_read') AS via_browser,
  COUNT(*) FILTER (WHERE catalog_source = 'inferred') AS via_inferred
FROM platform_products
WHERE platform = 'snoonu' AND import_id = <YOUR_IMPORT_ID>;
```

```sql
-- Sample of mapped rows for spot-checking
SELECT source_sku, name_en, snoonu_menu_path, catalog_source, catalog_confidence
FROM platform_products
WHERE platform = 'snoonu' AND import_id = <YOUR_IMPORT_ID>
  AND snoonu_category IS NOT NULL
ORDER BY id LIMIT 20;
```
