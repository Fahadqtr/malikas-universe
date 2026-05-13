/**
 * Shopify Admin API wrapper.
 *
 * REST endpoints (2025-07). Why REST instead of GraphQL: product CRUD
 * is straightforward, image uploads are simpler, and the failure modes
 * are easier to diagnose. We can move to GraphQL when we need bulk
 * operations.
 *
 * Required env (loaded lazily so missing keys don't kill startup):
 *   SHOPIFY_STORE_DOMAIN          e.g. malikas-universe.myshopify.com
 *   SHOPIFY_ADMIN_ACCESS_TOKEN    shpat_... (custom app token, not API secret)
 *   SHOPIFY_API_VERSION           default 2025-07
 *
 * Functions exported:
 *   createProduct(payload)     → ShopifyProduct
 *   updateProduct(id, payload) → ShopifyProduct
 *   uploadImage(id, url)       → ShopifyImage
 *   publishProduct(id)         → ShopifyProduct (status: 'active')
 *   archiveProduct(id)         → ShopifyProduct (status: 'archived')
 *   getProduct(id)             → ShopifyProduct | null
 *   adminUrl(id)               → https://...
 *   adminUrlForStorefront(handle)
 *
 * Every call:
 *   • Validates env on first use (clear error if missing)
 *   • Retries on 429 (Shopify rate limit) once with backoff
 *   • Throws with status code + Shopify error body for caller logging
 */

// ─── Types (subset we actually use) ──────────────────────────────────────────

export type ShopifyProductStatus = 'active' | 'archived' | 'draft';

export type ShopifyProductInput = {
  title: string;
  body_html?: string | null;        // HTML description
  vendor?: string | null;           // brand name
  product_type?: string | null;     // category name
  tags?: string;                    // comma-separated
  handle?: string;                  // URL slug; auto if omitted
  status?: ShopifyProductStatus;
  variants?: Array<{
    sku?: string;
    barcode?: string;
    price: string;                  // Shopify wants string
    inventory_quantity?: number;
    inventory_management?: 'shopify' | null;
    inventory_policy?: 'deny' | 'continue';
  }>;
  metafields?: Array<{
    namespace: string;
    key: string;
    type: 'single_line_text_field' | 'multi_line_text_field' | 'number_integer';
    value: string;
  }>;
};

export type ShopifyProduct = {
  id: number;
  handle: string;
  title: string;
  status: ShopifyProductStatus;
  vendor?: string;
  product_type?: string;
  admin_graphql_api_id?: string;
  variants?: Array<{ id: number; sku?: string; barcode?: string; price: string }>;
  images?: Array<{ id: number; src: string; position: number }>;
  updated_at: string;
};

export type ShopifyImage = {
  id: number;
  src: string;
  product_id: number;
  position: number;
};

// ─── Env + base URL ──────────────────────────────────────────────────────────

function getConfig(): { domain: string; token: string; version: string } {
  const domain = process.env.SHOPIFY_STORE_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION ?? '2025-07';
  if (!domain || !token) {
    throw new Error(
      'Shopify not configured. Set SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN in apps/web/.env.local',
    );
  }
  return { domain, token, version };
}

function adminBase(): string {
  const { domain, version } = getConfig();
  return `https://${domain}/admin/api/${version}`;
}

export function adminUrl(productId: number): string {
  const { domain } = getConfig();
  return `https://${domain}/admin/products/${productId}`;
}

export function adminUrlForStorefront(handle: string): string {
  const { domain } = getConfig();
  return `https://${domain.replace('.myshopify.com', '')}/products/${handle}`;
}

// ─── Low-level fetch with retry on 429 ───────────────────────────────────────

async function shopifyFetch(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<Response> {
  const { token } = getConfig();
  const url = `${adminBase()}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Shopify-Access-Token': token,
    ...(init.headers ?? {}),
  };
  const res = await fetch(url, { ...init, headers });

  // Shopify rate limit — retry once with Retry-After respect
  if (res.status === 429 && attempt < 1) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 2);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyFetch(path, init, attempt + 1);
  }

  return res;
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify ${label} failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Shopify ${label}: invalid JSON response`);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getProduct(id: number): Promise<ShopifyProduct | null> {
  const res = await shopifyFetch(`/products/${id}.json`);
  if (res.status === 404) return null;
  const body = await jsonOrThrow<{ product: ShopifyProduct }>(res, 'getProduct');
  return body.product;
}

export async function createProduct(input: ShopifyProductInput): Promise<ShopifyProduct> {
  const res = await shopifyFetch('/products.json', {
    method: 'POST',
    body: JSON.stringify({ product: input }),
  });
  const body = await jsonOrThrow<{ product: ShopifyProduct }>(res, 'createProduct');
  return body.product;
}

export async function updateProduct(
  id: number,
  input: Partial<ShopifyProductInput>,
): Promise<ShopifyProduct> {
  const res = await shopifyFetch(`/products/${id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ product: { id, ...input } }),
  });
  const body = await jsonOrThrow<{ product: ShopifyProduct }>(res, 'updateProduct');
  return body.product;
}

/**
 * Attach an image by URL. Shopify fetches the URL itself — much simpler
 * than multipart upload. Image must be publicly accessible.
 */
export async function uploadImage(productId: number, imageUrl: string): Promise<ShopifyImage> {
  const res = await shopifyFetch(`/products/${productId}/images.json`, {
    method: 'POST',
    body: JSON.stringify({ image: { src: imageUrl } }),
  });
  const body = await jsonOrThrow<{ image: ShopifyImage }>(res, 'uploadImage');
  return body.image;
}

export async function uploadImages(productId: number, imageUrls: string[]): Promise<ShopifyImage[]> {
  const out: ShopifyImage[] = [];
  for (const url of imageUrls) {
    out.push(await uploadImage(productId, url));
  }
  return out;
}

export async function publishProduct(id: number): Promise<ShopifyProduct> {
  return updateProduct(id, { status: 'active' });
}

export async function archiveProduct(id: number): Promise<ShopifyProduct> {
  return updateProduct(id, { status: 'archived' });
}

// ─── Slug helper — used when handle isn't provided ───────────────────────────

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')      // strip combining marks
    .replace(/[^a-z0-9\s-]/g, '')          // keep ASCII alphanum + space + dash
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// ─── Health check — verifies token/domain work ───────────────────────────────

export async function ping(): Promise<{ shop: string; plan: string }> {
  const res = await shopifyFetch('/shop.json');
  const body = await jsonOrThrow<{ shop: { name: string; plan_name: string } }>(res, 'ping');
  return { shop: body.shop.name, plan: body.shop.plan_name };
}
