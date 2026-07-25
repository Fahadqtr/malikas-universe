/**
 * Snoonu product extractor.
 *
 * Strategy (try in order, first match wins):
 *   1. JSON-LD Product schema (most reliable)
 *   2. __NEXT_DATA__ blob (Snoonu is a Next.js app)
 *   3. Open Graph meta tags + DOM scraping
 *
 * Polite scraping:
 *   - Sets a real-looking User-Agent
 *   - Adds 1.5s delay between requests by the caller
 *   - Handles 403/404/timeout gracefully — never throws
 *
 * Returns ExtractedProduct or { ok: false, reason }.
 */

export type ExtractedProduct = {
  ok: true;
  source_url: string;
  source_product_id: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand: string | null;
  category_hint: string | null;
  subcategory: string | null;
  product_type: string | null;
  price: number | null;
  discount_price: number | null;
  currency: string;
  sku: string | null;
  barcode: string | null;
  description_en: string | null;
  description_ar: string | null;
  image_url: string | null;
  image_urls: string[];
  variants: ExtractedVariant[];
  tags: string[];
  raw: unknown;
};

export type ExtractedVariant = {
  variant_type: 'color' | 'shade' | 'size' | 'quantity' | 'bundle' | 'scent' | 'model' | 'type' | 'other';
  variant_name: string;
  variant_value: string;
  source_url?: string;
  source_image_url?: string;
  price?: number;
  discount_price?: number;
};

export type ExtractFailure = {
  ok: false;
  source_url: string;
  reason: string;
  http_status?: number;
};

const POLITE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 MalikaImportBot/1.0';

const FETCH_TIMEOUT_MS = 15_000;

// ─── Polite fetch wrapper ───────────────────────────────────────────────────

async function politeFetch(url: string): Promise<
  | { ok: true; html: string; status: number }
  | { ok: false; status: number; reason: string }
> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': POLITE_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (!html || html.length < 500) {
      return { ok: false, status: res.status, reason: 'empty_or_tiny_response' };
    }
    return { ok: true, html, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : 'network error';
    return { ok: false, status: 0, reason: msg };
  }
}

// ─── HTML helpers (no cheerio dep — minimal regex parsers) ─────────────────

function extractTagContent(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(html);
  return m ? m[1]!.trim() : null;
}

function extractAllMatches(html: string, openTag: string, closeTag: string): string[] {
  const re = new RegExp(`<${openTag}[^>]*>([\\s\\S]*?)<\\/${closeTag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

function extractMeta(html: string, key: 'property' | 'name', value: string): string | null {
  const re = new RegExp(
    `<meta[^>]*${key}=["']${value}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const m = re.exec(html);
  if (m) return decodeHtmlEntities(m[1]!.trim());
  // Try reversed attribute order
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']+)["'][^>]*${key}=["']${value}["']`,
    'i',
  );
  const m2 = re2.exec(html);
  return m2 ? decodeHtmlEntities(m2[1]!.trim()) : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeJson<T = unknown>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.]/g, '');
    if (cleaned) {
      const n = parseFloat(cleaned);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function detectArabic(s: string): boolean {
  return /[؀-ۿ]/.test(s);
}

function splitByLanguage(s: string | null): { en: string | null; ar: string | null } {
  if (!s) return { en: null, ar: null };
  if (detectArabic(s)) {
    // Mixed Arabic+English text — try to split
    const arParts: string[] = [];
    const enParts: string[] = [];
    for (const seg of s.split(/[\n|•·\-–—]+/)) {
      const t = seg.trim();
      if (!t) continue;
      if (detectArabic(t)) arParts.push(t);
      else enParts.push(t);
    }
    return {
      ar: arParts.join(' ') || null,
      en: enParts.join(' ') || null,
    };
  }
  return { en: s, ar: null };
}

// ─── Strategy 1: JSON-LD Product ────────────────────────────────────────────

function extractFromJsonLd(html: string): Partial<ExtractedProduct> | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const parsed = safeJson<Record<string, unknown> | Array<Record<string, unknown>>>(m[1]!);
    if (!parsed) continue;
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    // Also handle @graph wrapper
    for (const cand of candidates) {
      const items = (cand['@graph'] as Array<Record<string, unknown>>) ?? [cand];
      for (const item of items) {
        const t = item['@type'];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((x) => typeof x === 'string' && /product/i.test(x))) {
          return mapJsonLdProduct(item);
        }
      }
    }
  }
  return null;
}

function mapJsonLdProduct(item: Record<string, unknown>): Partial<ExtractedProduct> {
  const out: Partial<ExtractedProduct> = { raw: { jsonld: item } };
  if (typeof item.name === 'string') {
    const { en, ar } = splitByLanguage(item.name);
    out.name_en = en;
    out.name_ar = ar;
  }
  if (typeof item.description === 'string') {
    const { en, ar } = splitByLanguage(item.description);
    out.description_en = en;
    out.description_ar = ar;
  }
  const brand = item.brand as Record<string, unknown> | string | undefined;
  if (typeof brand === 'string') out.brand = brand;
  else if (brand && typeof brand === 'object' && typeof brand.name === 'string') out.brand = brand.name as string;

  if (typeof item.sku === 'string') out.sku = item.sku;
  if (typeof item.gtin === 'string') out.barcode = item.gtin;
  if (typeof item.gtin13 === 'string') out.barcode = item.gtin13;
  if (typeof item.productID === 'string') out.source_product_id = item.productID;

  const offers = item.offers as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  if (offers) {
    const first = Array.isArray(offers) ? offers[0] : offers;
    if (first) {
      const p = parsePrice(first.price);
      if (p !== null) out.price = p;
      if (typeof first.priceCurrency === 'string') out.currency = first.priceCurrency;
    }
  }

  const image = item.image;
  const images: string[] = [];
  if (typeof image === 'string') images.push(image);
  else if (Array.isArray(image)) for (const x of image) if (typeof x === 'string') images.push(x);
  if (images.length > 0) {
    out.image_url = images[0];
    out.image_urls = images;
  }

  if (typeof item.category === 'string') out.category_hint = item.category;

  return out;
}

// ─── Strategy 2: __NEXT_DATA__ blob ────────────────────────────────────────

function extractFromNextData(html: string): Partial<ExtractedProduct> | null {
  const re = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
  const m = re.exec(html);
  if (!m) return null;
  const parsed = safeJson<Record<string, unknown>>(m[1]!);
  if (!parsed) return null;

  // Snoonu's product page typically nests it under props.pageProps.product
  const pageProps = (parsed as { props?: { pageProps?: Record<string, unknown> } })?.props?.pageProps;
  if (!pageProps) return null;
  const product = pageProps.product as Record<string, unknown> | undefined;
  if (!product) return null;

  const out: Partial<ExtractedProduct> = { raw: { nextData: product } };

  if (typeof product.name === 'string') {
    const { en, ar } = splitByLanguage(product.name);
    out.name_en = en;
    out.name_ar = ar;
  }
  if (typeof product.name_en === 'string') out.name_en = product.name_en;
  if (typeof product.name_ar === 'string') out.name_ar = product.name_ar;

  if (typeof product.description === 'string') {
    const { en, ar } = splitByLanguage(product.description);
    out.description_en = en;
    out.description_ar = ar;
  }
  if (typeof product.description_en === 'string') out.description_en = product.description_en;
  if (typeof product.description_ar === 'string') out.description_ar = product.description_ar;

  if (typeof product.brand === 'string') out.brand = product.brand;
  if (typeof product.sku === 'string') out.sku = product.sku;
  if (typeof product.barcode === 'string') out.barcode = product.barcode;
  if (typeof product.id === 'string' || typeof product.id === 'number') {
    out.source_product_id = String(product.id);
  }

  const price = parsePrice(product.price ?? product.original_price ?? product.unit_price);
  if (price !== null) out.price = price;
  const discount = parsePrice(product.discounted_price ?? product.sale_price);
  if (discount !== null) out.discount_price = discount;

  const images = (product.images as unknown[] | undefined) ?? (product.gallery as unknown[] | undefined);
  if (Array.isArray(images)) {
    const urls = images
      .map((img) => (typeof img === 'string' ? img : (img as { url?: string }).url))
      .filter((x): x is string => typeof x === 'string');
    if (urls.length > 0) {
      out.image_url = urls[0];
      out.image_urls = urls;
    }
  } else if (typeof product.image === 'string') {
    out.image_url = product.image;
    out.image_urls = [product.image];
  }

  // Variants/options
  const options = product.options as unknown[] | undefined;
  if (Array.isArray(options)) {
    const variants: ExtractedVariant[] = [];
    for (const opt of options) {
      const o = opt as { name?: string; values?: Array<{ name?: string; value?: string }> };
      const type = inferVariantType(o.name ?? '');
      const optName = o.name ?? type;
      for (const v of o.values ?? []) {
        if (typeof v.value === 'string' || typeof v.name === 'string') {
          variants.push({
            variant_type: type,
            variant_name: optName,
            variant_value: (v.value ?? v.name)!,
          });
        }
      }
    }
    if (variants.length > 0) out.variants = variants;
  }

  return out;
}

// ─── Strategy 3: Open Graph + DOM fallback ─────────────────────────────────

function extractFromOG(html: string): Partial<ExtractedProduct> {
  const out: Partial<ExtractedProduct> = { raw: { og: true } };

  const ogTitle = extractMeta(html, 'property', 'og:title');
  const ogDesc = extractMeta(html, 'property', 'og:description');
  const ogImage = extractMeta(html, 'property', 'og:image');
  const twTitle = extractMeta(html, 'name', 'twitter:title');
  const twDesc = extractMeta(html, 'name', 'twitter:description');
  const twImage = extractMeta(html, 'name', 'twitter:image');

  const title = ogTitle || twTitle || extractTagContent(html, 'title');
  if (title) {
    const { en, ar } = splitByLanguage(title);
    out.name_en = en;
    out.name_ar = ar;
  }

  const desc = ogDesc || twDesc;
  if (desc) {
    const { en, ar } = splitByLanguage(desc);
    out.description_en = en;
    out.description_ar = ar;
  }

  const img = ogImage || twImage;
  if (img) {
    out.image_url = img;
    out.image_urls = [img];
  }

  // Price from common patterns
  const priceMatch = /["'](?:price|original_price)["']\s*:\s*([0-9.]+)/i.exec(html);
  if (priceMatch) out.price = parseFloat(priceMatch[1]!);

  return out;
}

// ─── Helper: variant type inference from name ──────────────────────────────

function inferVariantType(name: string): ExtractedVariant['variant_type'] {
  const n = name.toLowerCase();
  if (/color|colour|لون/.test(n)) return 'color';
  if (/shade|درجة/.test(n)) return 'shade';
  if (/size|حجم|ml|gm|g$/.test(n)) return 'size';
  if (/qty|quantity|pcs|piece|كمية|عدد/.test(n)) return 'quantity';
  if (/bundle|set|طقم/.test(n)) return 'bundle';
  if (/scent|fragrance|عطر|رائحة/.test(n)) return 'scent';
  if (/model|نموذج/.test(n)) return 'model';
  if (/type|نوع/.test(n)) return 'type';
  return 'other';
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract product data from a Snoonu (or similar) product page URL.
 *
 * Tries multiple strategies and merges results, preferring more reliable
 * sources (JSON-LD > __NEXT_DATA__ > Open Graph).
 */
export async function extractSnoonuProduct(url: string): Promise<ExtractedProduct | ExtractFailure> {
  const fetched = await politeFetch(url);
  if (!fetched.ok) {
    return {
      ok: false,
      source_url: url,
      reason: fetched.reason,
      http_status: fetched.status,
    };
  }
  const html = fetched.html;

  const base: ExtractedProduct = {
    ok: true,
    source_url: url,
    source_product_id: null,
    name_en: null,
    name_ar: null,
    brand: null,
    category_hint: null,
    subcategory: null,
    product_type: null,
    price: null,
    discount_price: null,
    currency: 'QAR',
    sku: null,
    barcode: null,
    description_en: null,
    description_ar: null,
    image_url: null,
    image_urls: [],
    variants: [],
    tags: [],
    raw: {},
  };

  // Merge in order of reliability (later wins when present)
  const og = extractFromOG(html);
  Object.assign(base, og);

  const nextData = extractFromNextData(html);
  if (nextData) Object.assign(base, nextData);

  const jsonld = extractFromJsonLd(html);
  if (jsonld) Object.assign(base, jsonld);

  // Combine raw payloads for audit
  base.raw = {
    og: og.raw,
    nextData: nextData?.raw,
    jsonld: jsonld?.raw,
  };

  // Derive source_product_id from URL if missing
  if (!base.source_product_id) {
    const m = /\/products?\/([a-z0-9-]+)/i.exec(url);
    if (m) base.source_product_id = m[1]!;
  }

  return base;
}

/**
 * Extract from a pasted list of URLs (newline-separated), one at a time
 * with polite delay between requests.
 */
export async function extractMany(
  urls: string[],
  opts: { delayMs?: number; onItem?: (i: number, result: ExtractedProduct | ExtractFailure) => void } = {},
): Promise<Array<ExtractedProduct | ExtractFailure>> {
  const delayMs = opts.delayMs ?? 1500;
  const results: Array<ExtractedProduct | ExtractFailure> = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!.trim();
    if (!url) continue;
    const r = await extractSnoonuProduct(url);
    results.push(r);
    opts.onItem?.(i, r);
    if (i < urls.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return results;
}
