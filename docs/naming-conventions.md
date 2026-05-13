# Naming Conventions

Locked rules across the entire codebase. Consistency = velocity.

## Files & Folders

| What | Style | Example |
|---|---|---|
| Folders | `kebab-case` | `product-images/`, `ai-tools/` |
| TS source files | `kebab-case.ts` | `supabase-client.ts`, `category-engine.ts` |
| React components | `PascalCase.tsx` | `ProductCard.tsx`, `ImageUploader.tsx` |
| Test files | `*.test.ts` next to source | `category.test.ts` |
| Route files (Next.js) | `route.ts`, `page.tsx`, `layout.tsx` | (Next.js convention) |
| SQL migrations | `NNN_description.sql` | `002_core_schema.sql` |
| Env files | `.env.local`, `.env.example` | never `.env.production` in repo |
| Markdown docs | `kebab-case.md` | `tech-stack.md`, `naming-conventions.md` |

## TypeScript

| What | Style | Example |
|---|---|---|
| Functions | `camelCase` | `getProduct`, `generateSku` |
| Variables | `camelCase` | `masterSku`, `productList` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAIN_CATEGORIES`, `MAX_PRICE` |
| Types / Interfaces | `PascalCase` | `Product`, `ApiResponse<T>` |
| Type aliases | `PascalCase` | `Platform`, `StockStatus` |
| Enums (prefer string unions) | `PascalCase` keys | `'Korean Skincare'` |
| Generic params | Single capital | `T`, `K`, `V` |
| Boolean variables | start with `is`/`has`/`should` | `isActive`, `hasBarcode` |

## Database (PostgreSQL)

| What | Style | Example |
|---|---|---|
| Tables | `snake_case` plural | `products`, `product_images` |
| Columns | `snake_case` | `master_sku`, `product_name_en` |
| Primary keys | `id` (bigint) or `<table>_id` | `id`, `category_id` |
| Foreign keys | `<referenced>_id` | `brand_id`, `master_sku` (text PK) |
| Indexes | `idx_<table>_<column>` | `idx_products_brand` |
| Functions | `snake_case` verb-first | `generate_master_sku`, `rollback_product` |
| Triggers | `trg_<table>_<purpose>` | `trg_products_audit` |
| Views | `v_<purpose>` | `v_dashboard_kpis` |
| Check constraints | `<column>_<rule>` | `discount_below_price` |
| Booleans | `is_<state>` or `has_<thing>` | `is_active`, `is_primary` |

## API Routes

| What | Style | Example |
|---|---|---|
| Collection | plural | `/api/products` |
| Single resource | `/api/products/[sku]` | `/api/products/MK-SKIN-0001` |
| Sub-resource | nested plural | `/api/products/[sku]/images` |
| Action | verb after resource | `/api/products/[sku]/rollback` |
| Multi-word route | kebab-case | `/api/platform-mappings`, `/api/review-queue` |

## SKU Format (LOCKED)

```
MK-{CATEGORY_CODE}-{4-DIGIT-SEQUENCE}
```
Examples:
- `MK-SKIN-0001` (Korean Skincare)
- `MK-MAKEUP-0247`
- `MK-TREND-0089`

Category codes (locked, see `packages/shared/src/types/product.ts`):
| Category | Code |
|---|---|
| Korean Skincare | `SKIN` |
| Thai Products | `THAI` |
| Hair Care | `HAIR` |
| Makeup | `MAKEUP` |
| Body Care | `BODY` |
| Perfumes | `PERF` |
| Beauty Tools | `TOOL` |
| Bags & Accessories | `BAG` |
| Gifts & Sets | `GIFT` |
| Kids & Toys | `KIDS` |
| Trending Products | `TREND` |

## Image Files (LOCKED)

| What | Format |
|---|---|
| R2 key | `products/{master_sku_lowercase}/{filename_lowercase}` |
| Primary | always `primary.jpg` |
| Secondary | `02.jpg`, `03.jpg`, ... |
| Other variants | `lifestyle.jpg`, `ingredients.jpg`, `box.jpg` |
| CDN URL | `https://cdn.malikasuniverse.com/products/{sku}/primary.jpg` |

## Branches & Commits

| What | Style | Example |
|---|---|---|
| Branch | `<type>/<short-desc>` | `feat/product-edit-page`, `fix/sku-collision` |
| Commit | Conventional Commits | `feat(products): add bulk edit`, `fix(ai): prevent price hallucination` |

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `style`.

## Env Variable Naming

| Style | Use |
|---|---|
| `NEXT_PUBLIC_*` | Exposed to browser (Next.js convention) |
| `*_API_KEY`, `*_SECRET`, `*_TOKEN` | Server-only, never expose to client |
| `*_URL` | Full URLs only |
| `*_ID` | IDs/handles |

## Folder Layout per Domain

When adding a new domain (e.g., "orders"):
```
apps/web/app/orders/
├── page.tsx
├── [id]/page.tsx
└── new/page.tsx

apps/web/app/api/orders/
├── route.ts
└── [id]/route.ts

apps/web/components/orders/
├── OrderCard.tsx
└── OrderTable.tsx

packages/shared/src/types/order.ts
packages/shared/src/engines/order-engine.ts  (if logic is shared)
```
