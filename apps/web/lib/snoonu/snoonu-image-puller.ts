/**
 * SNOONU IMAGE PULLER — Future feature, not implemented yet.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Goal: given a Snoonu product page URL (or product ID), automatically
 * download the canonical product image and store it in Supabase Storage
 * so the AI Autofill flow can analyze it without manual upload.
 *
 * Why deferred to a later phase:
 *   1. Snoonu doesn't expose a public API — scraping needs HTML inspection.
 *   2. Snoonu's anti-bot may block server-side fetches → we may need to
 *      use a headless browser (Playwright) running on the VPS.
 *   3. Image CDN URLs on Snoonu sometimes rotate / expire.
 *
 * Implementation strategy (when we tackle it):
 *   - Phase 1: simple `fetch` of the product page HTML
 *   - Phase 2: regex / cheerio to extract `og:image` or product-image element
 *   - Phase 3: fallback to Playwright if simple fetch is blocked
 *   - Phase 4: cache extracted URLs in `system_settings` or a new table to
 *              avoid hammering Snoonu
 *
 * Until implemented, all three functions below throw NotImplementedError
 * so accidental calls fail loudly instead of returning silently.
 *
 * Public surface (do not change signatures lightly — UI may already wire
 * against them):
 *
 *   - pullProductImageFromSnoonu(productUrl): Promise<{ storage_path, public_url }>
 *   - extractImageUrlFromSnoonuPage(html): string | null
 *   - downloadAndStoreSnoonuImage(imageUrl, masterSku?): Promise<{ storage_path, public_url }>
 */

import { STORAGE_BUCKET, productImageStoragePath, publicImageUrl } from '@/lib/supabase/storage';

export class SnoonuPullerNotImplementedError extends Error {
  constructor(public method: string) {
    super(`Snoonu image puller method "${method}" is not implemented yet — see lib/snoonu/snoonu-image-puller.ts`);
    this.name = 'SnoonuPullerNotImplementedError';
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Given a Snoonu product page URL, fetch the page, extract the primary
 * product image, download it, store it in Supabase Storage, return the
 * public CDN URL.
 *
 * @param productUrl — e.g. "https://snoonu.com/qa/en/p/medicube-zero-pore-pad-2-0"
 * @param masterSku — optional. If provided, image is stored under products/{sku}.
 *                    Otherwise stored under ai-autofill-temp/.
 *
 * @returns { storage_path, public_url, source_url, scraped_at }
 *
 * Errors:
 *   - SnoonuPullerNotImplementedError (always, currently)
 *   - In the future: NetworkError, BlockedByAntibotError, ImageNotFoundError
 */
export async function pullProductImageFromSnoonu(
  productUrl: string,
  masterSku?: string,
): Promise<{ storage_path: string; public_url: string; source_url: string; scraped_at: string }> {
  // FUTURE IMPLEMENTATION:
  //   1. const html = await fetch(productUrl).then((r) => r.text());
  //   2. const imgUrl = extractImageUrlFromSnoonuPage(html);
  //   3. if (!imgUrl) throw new ImageNotFoundError();
  //   4. const stored = await downloadAndStoreSnoonuImage(imgUrl, masterSku);
  //   5. return { ...stored, source_url: productUrl, scraped_at: new Date().toISOString() };
  void productUrl;
  void masterSku;
  void STORAGE_BUCKET; // keep import referenced
  throw new SnoonuPullerNotImplementedError('pullProductImageFromSnoonu');
}

/**
 * Parse Snoonu product page HTML and return the highest-quality image URL.
 *
 * Strategy (when implemented):
 *   1. Prefer <meta property="og:image"> — Snoonu sets this for sharing
 *   2. Fall back to product-image-element selector inspection
 *   3. Reject placeholder / spinner / sprite images
 *   4. Return null if nothing usable
 *
 * @returns string (image URL) or null if not found
 */
export function extractImageUrlFromSnoonuPage(html: string): string | null {
  // FUTURE IMPLEMENTATION:
  //   const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  //   if (ogMatch) return ogMatch[1];
  //
  //   const imgMatch = html.match(/<img[^>]+class="[^"]*product-image[^"]*"[^>]+src="([^"]+)"/i);
  //   if (imgMatch && !/placeholder|spinner/i.test(imgMatch[1])) return imgMatch[1];
  //
  //   return null;
  void html;
  throw new SnoonuPullerNotImplementedError('extractImageUrlFromSnoonuPage');
}

/**
 * Download an image from any public URL and upload it to Supabase Storage.
 *
 * @param imageUrl — public URL of the image to download
 * @param masterSku — if provided, stored at products/{sku}/primary.jpg
 *                    otherwise stored at ai-autofill-temp/{uuid}.jpg
 *
 * @returns { storage_path, public_url, content_type, size_bytes }
 */
export async function downloadAndStoreSnoonuImage(
  imageUrl: string,
  masterSku?: string,
): Promise<{ storage_path: string; public_url: string; content_type: string; size_bytes: number }> {
  // FUTURE IMPLEMENTATION:
  //   1. const res = await fetch(imageUrl);
  //   2. if (!res.ok) throw new DownloadFailedError(res.status);
  //   3. const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  //   4. validate contentType is image/jpeg | png | webp
  //   5. const buffer = new Uint8Array(await res.arrayBuffer());
  //   6. validate buffer.byteLength <= 5MB
  //   7. const path = masterSku
  //        ? productImageStoragePath(masterSku, 'primary.jpg')
  //        : `ai-autofill-temp/${crypto.randomUUID()}.jpg`;
  //   8. uploadToSupabaseStorage(path, buffer, contentType);
  //   9. return { storage_path: path, public_url: publicImageUrl(path), content_type, size_bytes };
  void imageUrl;
  void masterSku;
  void productImageStoragePath;
  void publicImageUrl;
  throw new SnoonuPullerNotImplementedError('downloadAndStoreSnoonuImage');
}
