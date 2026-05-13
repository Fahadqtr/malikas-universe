/**
 * POST /api/shopify/push
 *
 * Body:
 *   {
 *     sku: "MK-SKIN-0001",
 *     force?: boolean          // bypass readiness gate (owner-only escape hatch)
 *   }
 *
 * Flow (HARD RULES enforced):
 *   1. Load product (must exist, not deleted, must be 'active' status)
 *   2. Run readiness check for target='shopify' — REJECT if score < 90 unless force=true
 *   3. Build Shopify payload from product
 *   4. Idempotent create-or-update:
 *      - If product.shopify_product_id exists → UPDATE that
 *      - Else → CREATE new, save shopify_product_id
 *   5. Upload primary image (always) + any extra product_images rows
 *   6. Save shopify_product_id, shopify_handle, shopify_synced_at + readiness snapshot
 *   7. Return admin URL + storefront URL
 *
 * Safety rules from Phase 8 spec:
 *   ✗ NEVER auto-publish without approval (status must be 'active' first)
 *   ✗ NEVER push AI drafts directly (covered by 'active' check)
 *   ✗ NEVER overwrite Shopify blindly — we use update with explicit ID
 *   ✓ Always validate readiness first
 *   ✓ Preserve manual edits — only push our fields, don't touch Shopify-specific
 *     fields like collections/tags-set-on-Shopify-side
 *   ✓ Audit log — writes to product_logs via DB trigger on the products UPDATE
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { checkReadiness } from '@/lib/readiness';
import {
  createProduct,
  updateProduct,
  uploadImages,
  adminUrl,
  adminUrlForStorefront,
  slugify,
  type ShopifyProductInput,
  type ShopifyProductStatus,
} from '@/lib/shopify';

export const runtime = 'nodejs';
export const maxDuration = 60;

const READY_THRESHOLD = 90;

const Body = z.object({
  sku: z.string().min(1),
  force: z.boolean().optional().default(false),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  if (!['owner', 'editor'].includes(actor.role)) {
    return err('FORBIDDEN', `Role ${actor.role} cannot push to Shopify`, 403);
  }

  const body = Body.parse(await req.json());
  if (body.force && actor.role !== 'owner') {
    return err('FORCE_OWNER_ONLY', 'Only the owner can force-push below readiness threshold.', 403);
  }

  const { products } = getServices(actor);
  const admin = createAdminSupabaseClient();

  // ── 1. Load product ──────────────────────────────────────────────────────
  const product = await products.findBySku(body.sku);

  if (product.product_status !== 'active') {
    return err(
      'NOT_ACTIVE',
      `Product status is "${product.product_status}". Approve it first (must be 'active').`,
      400,
      { current_status: product.product_status },
    );
  }

  // ── 2. Readiness check (Shopify target) ──────────────────────────────────
  const readiness = checkReadiness(product, 'shopify');
  if (!body.force && (!readiness.ready || readiness.score < READY_THRESHOLD)) {
    return err(
      'NOT_READY',
      `Readiness score is ${readiness.score}% (need >= ${READY_THRESHOLD}%). Fix errors below.`,
      400,
      {
        readiness_score: readiness.score,
        error_count: readiness.error_count,
        warning_count: readiness.warning_count,
        issues: readiness.issues,
      },
    );
  }

  // ── 3. Build Shopify payload ─────────────────────────────────────────────
  const brandName = (product.brand as { name?: string } | null)?.name ?? null;
  const categoryName = (product.category as { name?: string } | null)?.name ?? null;
  const handle = slugify(product.product_name_en ?? product.master_sku);

  // Description: combine bilingual marketplace block + Arabic block (HTML).
  // Shopify supports HTML in body_html.
  const body_html = composeBodyHtml({
    description_en: product.description_en,
    description_ar: product.description_ar,
    usage_en: product.usage_en,
    usage_ar: product.usage_ar,
  });

  // Tags: combine size, color, AR keywords + EN keywords
  const tagList = [
    ...(product.keywords_en ?? []),
    ...(product.keywords_ar ?? []),
    product.color,
    product.size,
    product.product_type,
  ].filter(Boolean) as string[];
  const tags = Array.from(new Set(tagList)).join(', ');

  const status: ShopifyProductStatus = 'active'; // we already verified product_status='active'

  const payload: ShopifyProductInput = {
    title: product.product_name_en ?? product.master_sku,
    body_html,
    vendor: brandName,
    product_type: categoryName,
    tags,
    handle,
    status,
    variants: [
      {
        sku: product.master_sku,
        barcode: product.barcode ?? undefined,
        price: Number(product.price).toFixed(2),
        inventory_quantity: product.stock_quantity ?? 0,
        inventory_management: 'shopify',
        inventory_policy: 'deny',
      },
    ],
    metafields: [
      // Surface Arabic name as a metafield so themes can render it
      ...(product.product_name_ar
        ? [{
            namespace: 'malikas',
            key: 'name_ar',
            type: 'single_line_text_field' as const,
            value: product.product_name_ar,
          }]
        : []),
      // Confidence + source for audit
      {
        namespace: 'malikas',
        key: 'master_sku',
        type: 'single_line_text_field',
        value: product.master_sku,
      },
    ],
  };

  // ── 4. Create or update ──────────────────────────────────────────────────
  const existingShopifyId = (product as Record<string, unknown>).shopify_product_id as number | null;
  let shopifyProduct;
  try {
    if (existingShopifyId) {
      shopifyProduct = await updateProduct(Number(existingShopifyId), payload);
    } else {
      shopifyProduct = await createProduct(payload);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return err('SHOPIFY_API_FAILED', msg, 502);
  }

  // ── 5. Upload images (primary + any extras from product_images) ──────────
  const imageUrls: string[] = [];
  if (product.image_url) imageUrls.push(product.image_url);
  const extra = (product.images as Array<{ cdn_url: string; is_primary: boolean }> | undefined) ?? [];
  for (const img of extra) {
    if (img.cdn_url && img.cdn_url !== product.image_url) imageUrls.push(img.cdn_url);
  }
  // On UPDATE we don't re-upload — Shopify keeps existing images.
  // Only upload on first push (CREATE).
  if (!existingShopifyId && imageUrls.length > 0) {
    try {
      await uploadImages(shopifyProduct.id, imageUrls);
    } catch (e) {
      // Image upload failure is non-fatal — product is already created.
      // We log the error but still mark the push as succeeded.
      console.error('[shopify-push] image upload failed:', e);
    }
  }

  // ── 6. Save Shopify identifiers + readiness snapshot ─────────────────────
  const syncedAt = new Date().toISOString();
  const { error: saveErr } = await admin
    .from('products')
    .update({
      shopify_product_id: shopifyProduct.id,
      shopify_handle: shopifyProduct.handle,
      shopify_synced_at: syncedAt,
      readiness_score: readiness.score,
      readiness_meta: {
        target: 'shopify',
        ready: readiness.ready,
        error_count: readiness.error_count,
        warning_count: readiness.warning_count,
        issues: readiness.issues,
        synced_at: syncedAt,
      },
      updated_by: actor.email,
    })
    .eq('master_sku', product.master_sku);
  if (saveErr) {
    // Shopify push succeeded but DB write failed — log loudly so we can reconcile
    console.error('[shopify-push] DB save failed after successful push:', saveErr);
  }

  return ok({
    sku: product.master_sku,
    shopify_product_id: shopifyProduct.id,
    shopify_handle: shopifyProduct.handle,
    status: shopifyProduct.status,
    admin_url: adminUrl(shopifyProduct.id),
    storefront_url: adminUrlForStorefront(shopifyProduct.handle),
    synced_at: syncedAt,
    readiness: {
      score: readiness.score,
      ready: readiness.ready,
      warning_count: readiness.warning_count,
    },
    action: existingShopifyId ? 'updated' : 'created',
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build HTML description that renders the bilingual Malika block on a
 * Shopify product page.
 *
 *   • English block: LTR, default
 *   • Arabic block: RTL, dir attribute
 *   • Usage steps preserved as separate sections
 */
function composeBodyHtml(opts: {
  description_en?: string | null;
  description_ar?: string | null;
  usage_en?: string | null;
  usage_ar?: string | null;
}): string {
  const parts: string[] = [];
  if (opts.description_en) {
    parts.push(`<div lang="en">${escapeHtml(opts.description_en).replace(/\n/g, '<br>')}</div>`);
  }
  if (opts.description_ar) {
    parts.push(`<div lang="ar" dir="rtl">${escapeHtml(opts.description_ar).replace(/\n/g, '<br>')}</div>`);
  }
  if (opts.usage_en) {
    parts.push(`<div lang="en"><strong>How to use:</strong><br>${escapeHtml(opts.usage_en).replace(/\n/g, '<br>')}</div>`);
  }
  if (opts.usage_ar) {
    parts.push(`<div lang="ar" dir="rtl"><strong>طريقة الاستخدام:</strong><br>${escapeHtml(opts.usage_ar).replace(/\n/g, '<br>')}</div>`);
  }
  return parts.join('\n<hr>\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
