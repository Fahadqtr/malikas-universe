/**
 * Snoonu image pull → Supabase Storage with SKU-based naming.
 *
 * Phase 13.4 of Snoonu import pipeline.
 *
 * Naming contract (locked):
 *   - Parent image:  products/{sku-lower}/{SKU}.jpg
 *     e.g.            products/mk-skin-0001/MK-SKIN-0001.jpg
 *   - Variant image: products/{parent-sku-lower}/{VARIANT_SKU}.jpg
 *     e.g.            products/mk-makeup-0001/MK-MAKEUP-0001-RED.jpg
 *   - Duplicates:    suffix with -2, -3, ... e.g. MK-SKIN-0001-2.jpg
 *
 * Pipeline:
 *   1. SKU must already be generated (see lib/sku-generator).
 *   2. Download image with politeFetch (User-Agent, timeout, no auth).
 *   3. Validate content-type, size (≤ 8MB), magic bytes (jpeg/png/webp).
 *   4. Normalize → upload as JPEG (Supabase handles transcoding lazily).
 *   5. Insert into Supabase Storage at the locked path.
 *   6. Return metadata block ready to write into product_images row.
 *
 * Errors:
 *   - Never throws on network failure; returns { ok: false, reason }.
 *   - Storage upload failures DO throw — caller decides retry/skip.
 *
 * NOT in scope here:
 *   - product_images row insert (caller handles)
 *   - Image quality scoring (Phase 13.7)
 *   - AI background removal / square cropping (Phase 13.7)
 */

import { STORAGE_BUCKET, publicImageUrl } from '@/lib/supabase/storage';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { imageFilenameForSku, imageStoragePathForSku } from '@/lib/sku-generator';

// ─── Types ──────────────────────────────────────────────────────────────────

export type PulledImage = {
  ok: true;
  sku: string;
  source_url: string;
  storage_path: string;        // products/{sku-lower}/{SKU}.jpg
  public_url: string;          // full CDN URL on Supabase
  image_filename: string;      // {SKU}.jpg
  content_type: string;
  size_bytes: number;
  width: number | null;        // best-effort; null if not detected
  height: number | null;
  is_square: boolean | null;
  duplicate_suffix: number | null;
};

export type PullFailure = {
  ok: false;
  sku: string;
  source_url: string;
  reason: string;
  http_status?: number;
};

const POLITE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 MalikaImportBot/1.0';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 8 MB
const MIN_IMAGE_BYTES = 1024;              // 1 KB sanity floor

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

// ─── Polite image fetcher ───────────────────────────────────────────────────

async function fetchImageBytes(url: string): Promise<
  | { ok: true; body: Uint8Array; content_type: string; size: number }
  | { ok: false; reason: string; http_status?: number }
> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': POLITE_UA,
        'Accept': 'image/jpeg,image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      return { ok: false, reason: `http_${res.status}`, http_status: res.status };
    }

    const ctRaw = ((res.headers.get('content-type') ?? '').toLowerCase().split(';')[0] ?? '').trim();
    const content_type = ctRaw || 'image/jpeg';

    if (!ALLOWED_TYPES.has(content_type)) {
      return { ok: false, reason: `unsupported_content_type:${content_type}`, http_status: res.status };
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    const size = buf.byteLength;

    if (size < MIN_IMAGE_BYTES) return { ok: false, reason: `too_small:${size}` };
    if (size > MAX_IMAGE_BYTES) return { ok: false, reason: `too_large:${size}` };

    if (!hasImageMagicBytes(buf, content_type)) {
      return { ok: false, reason: 'magic_bytes_mismatch' };
    }

    return { ok: true, body: buf, content_type, size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.includes('aborted') ? 'timeout' : `network:${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the first bytes match the declared content type. */
function hasImageMagicBytes(buf: Uint8Array, contentType: string): boolean {
  if (buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (contentType.includes('png')) {
    return (
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    );
  }
  // WebP: "RIFF" .... "WEBP"
  if (contentType.includes('webp')) {
    return (
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    );
  }
  return false;
}

// ─── Image dimension reader (lightweight, no deps) ──────────────────────────

/**
 * Best-effort dimension extraction from raw bytes.
 * Returns null if format isn't recognized or header is malformed.
 * Note: we deliberately avoid `sharp`/`probe-image-size` to stay edge-runtime safe.
 */
function readImageDimensions(buf: Uint8Array, contentType: string): { width: number; height: number } | null {
  try {
    if (contentType.includes('png')) {
      // PNG IHDR at offset 16 (width) and 20 (height), big-endian
      if (buf.length < 24) return null;
      const w = (buf[16]! << 24) | (buf[17]! << 16) | (buf[18]! << 8) | buf[19]!;
      const h = (buf[20]! << 24) | (buf[21]! << 16) | (buf[22]! << 8) | buf[23]!;
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }
    if (contentType.includes('webp')) {
      // VP8L: starts at byte 12 = "VP8L", width-1 at bytes 21-22 LE (14 bits each)
      // VP8 : width/height at offset 26-29
      if (buf.length < 30) return null;
      const fmt = String.fromCharCode(buf[12]!, buf[13]!, buf[14]!, buf[15]!);
      if (fmt === 'VP8L') {
        const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width: w, height: h };
      }
      if (fmt === 'VP8 ') {
        const w = (buf[26]! | (buf[27]! << 8)) & 0x3fff;
        const h = (buf[28]! | (buf[29]! << 8)) & 0x3fff;
        return w > 0 && h > 0 ? { width: w, height: h } : null;
      }
      if (fmt === 'VP8X') {
        // Extended header: dims at bytes 24..29 (width-1, height-1 as 24-bit LE)
        const w = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
        const h = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
        return { width: w, height: h };
      }
      return null;
    }
    if (contentType.includes('jpeg') || contentType.includes('jpg')) {
      // Walk JPEG segments: FF Cn ... where Cn is SOF marker (0xC0..0xCF except C4/C8/CC)
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) return null;
        let marker = buf[i + 1];
        while (marker === 0xff && i + 2 < buf.length) {
          i++;
          marker = buf[i + 1];
        }
        i += 2;
        // SOF0..SOF15 (except DHT C4, JPG C8, DAC CC)
        const isSof =
          marker !== undefined &&
          marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          if (i + 7 > buf.length) return null;
          const h = (buf[i + 3]! << 8) | buf[i + 4]!;
          const w = (buf[i + 5]! << 8) | buf[i + 6]!;
          return w > 0 && h > 0 ? { width: w, height: h } : null;
        }
        // Otherwise skip segment using 2-byte length
        if (i + 2 > buf.length) return null;
        const segLen = (buf[i]! << 8) | buf[i + 1]!;
        if (segLen < 2) return null;
        i += segLen;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

// ─── Duplicate-aware uploader ───────────────────────────────────────────────

/**
 * Find the next free path under products/{sku-lower}/ for this SKU.
 * Tries {SKU}.jpg → {SKU}-2.jpg → {SKU}-3.jpg ... up to 9.
 *
 * Returns { path, filename, suffix } where suffix is null for primary.
 */
async function findFreeImagePath(sku: string): Promise<{ path: string; filename: string; suffix: number | null }> {
  const admin = createAdminSupabaseClient();
  const folder = `products/${sku.toLowerCase()}`;

  // Cheap path: try primary first
  const primaryPath = imageStoragePathForSku(sku);
  const exists = await pathExists(admin, primaryPath);
  if (!exists) {
    return { path: primaryPath, filename: imageFilenameForSku(sku), suffix: null };
  }

  // Walk -2..-9
  for (let n = 2; n <= 9; n++) {
    const path = imageStoragePathForSku(sku, n);
    // eslint-disable-next-line no-await-in-loop
    const taken = await pathExists(admin, path);
    if (!taken) {
      return { path, filename: imageFilenameForSku(sku, n), suffix: n };
    }
  }

  // Last resort: overwrite primary (rare — 10+ duplicates suggests bug)
  console.warn(`[image-pull] ${folder} has 9+ images, overwriting primary for ${sku}`);
  return { path: primaryPath, filename: imageFilenameForSku(sku), suffix: null };
}

async function pathExists(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  storagePath: string,
): Promise<boolean> {
  const slash = storagePath.lastIndexOf('/');
  const folder = storagePath.slice(0, slash);
  const file = storagePath.slice(slash + 1);
  const { data } = await admin.storage.from(STORAGE_BUCKET).list(folder, {
    search: file,
    limit: 1,
  });
  return !!data && data.some((f) => f.name.toLowerCase() === file.toLowerCase());
}

// ─── Main entry points ──────────────────────────────────────────────────────

/**
 * Pull a single image for a SKU and store it in Supabase.
 *
 * @param sku           Already-generated Malika SKU (parent or variant).
 *                      e.g. "MK-SKIN-0001" or "MK-MAKEUP-0001-RED"
 * @param sourceUrl     Public image URL on Snoonu CDN.
 * @param opts.overwrite  When true, overwrite the primary path even if it exists.
 *                        Default: false (duplicate suffix is used).
 */
export async function pullImageForSku(
  sku: string,
  sourceUrl: string,
  opts: { overwrite?: boolean } = {},
): Promise<PulledImage | PullFailure> {
  // 1. Download bytes
  const fetched = await fetchImageBytes(sourceUrl);
  if (!fetched.ok) {
    return {
      ok: false,
      sku,
      source_url: sourceUrl,
      reason: fetched.reason,
      http_status: fetched.http_status,
    };
  }

  // 2. Resolve storage path (primary vs duplicate)
  const target = opts.overwrite
    ? {
        path: imageStoragePathForSku(sku),
        filename: imageFilenameForSku(sku),
        suffix: null as number | null,
      }
    : await findFreeImagePath(sku);

  // 3. Upload
  const admin = createAdminSupabaseClient();
  const { error } = await admin.storage.from(STORAGE_BUCKET).upload(target.path, fetched.body, {
    contentType: fetched.content_type,
    upsert: opts.overwrite ?? false,
    cacheControl: '31536000',
  });

  if (error) {
    return {
      ok: false,
      sku,
      source_url: sourceUrl,
      reason: `storage_upload_failed:${error.message}`,
    };
  }

  // 4. Read dimensions (best effort)
  const dims = readImageDimensions(fetched.body, fetched.content_type);
  const isSquare = dims
    ? Math.abs(dims.width - dims.height) / Math.max(dims.width, dims.height) < 0.02
    : null;

  return {
    ok: true,
    sku,
    source_url: sourceUrl,
    storage_path: target.path,
    public_url: publicImageUrl(target.path),
    image_filename: target.filename,
    content_type: fetched.content_type,
    size_bytes: fetched.size,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    is_square: isSquare,
    duplicate_suffix: target.suffix,
  };
}

/**
 * Pull every image (primary + extras) for a parent product.
 *
 * @param sku        Parent SKU. First URL → MK-SKIN-0001.jpg, second → ...-2.jpg, ...
 * @param sourceUrls Ordered list of source image URLs (primary first).
 *
 * Stops on storage error. Continues on individual fetch failure (records it).
 */
export async function pullAllImagesForSku(
  sku: string,
  sourceUrls: string[],
): Promise<{
  primary: PulledImage | PullFailure | null;
  extras: Array<PulledImage | PullFailure>;
}> {
  if (sourceUrls.length === 0) {
    return { primary: null, extras: [] };
  }

  // Primary always overwrites — it's the canonical product image.
  const primary = await pullImageForSku(sku, sourceUrls[0]!, { overwrite: true });
  const extras: Array<PulledImage | PullFailure> = [];

  for (let i = 1; i < sourceUrls.length && i < 9; i++) {
    // Polite 800ms gap so Snoonu CDN doesn't rate-limit us.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 800));
    // eslint-disable-next-line no-await-in-loop
    const result = await pullImageForSku(sku, sourceUrls[i]!, { overwrite: false });
    extras.push(result);
  }

  return { primary, extras };
}

/**
 * Pull a variant image. Same contract as pullImageForSku, just clearer name.
 * Variant SKU must already contain the suffix (e.g. "MK-MAKEUP-0001-RED").
 */
export async function pullVariantImage(
  variantSku: string,
  sourceUrl: string,
): Promise<PulledImage | PullFailure> {
  return pullImageForSku(variantSku, sourceUrl, { overwrite: true });
}

// ─── Convenience: build product_images row from a successful pull ───────────

/**
 * Map a PulledImage into the shape required by `product_images` table.
 * Caller still needs to set product_id + sort_order.
 */
export function toProductImageRow(pulled: PulledImage, opts: {
  source_platform?: string;       // 'snoonu' | 'shopify' | 'manual'
  import_item_id?: string | null;
  is_primary?: boolean;
}) {
  return {
    storage_path: pulled.storage_path,
    public_url: pulled.public_url,
    filename: pulled.image_filename,
    content_type: pulled.content_type,
    size_bytes: pulled.size_bytes,
    width: pulled.width,
    height: pulled.height,
    is_square: pulled.is_square,
    is_primary: opts.is_primary ?? false,
    source_platform: opts.source_platform ?? 'snoonu',
    source_url: pulled.source_url,
    import_item_id: opts.import_item_id ?? null,
  };
}
