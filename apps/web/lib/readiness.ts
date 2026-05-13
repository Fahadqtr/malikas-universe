/**
 * Marketplace Readiness Engine.
 *
 * Single source of truth for "is this product ready to publish?"
 * Used by:
 *   • GET /api/products/[sku]/readiness — dashboard badge
 *   • POST /api/shopify/push — gates the push (score >= 90)
 *   • Inline editor UI — live preview as user edits
 *
 * Adding a new marketplace = add to MarketplaceTarget union + register a
 * targetRules entry. Nothing else changes.
 *
 * Score model:
 *   • Errors deduct heavily (per rule)
 *   • Warnings deduct lightly
 *   • ready = (score >= 90) AND (no errors)
 *
 * The function is PURE — given the same product + target it always returns
 * the same result. No DB calls. Hand it a product object loaded elsewhere.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type MarketplaceTarget = 'shopify' | 'snoonu' | 'talabat' | 'rafeeq';

export type ReadinessIssue = {
  code: string;                       // machine-readable id, e.g. 'MISSING_NAME_EN'
  severity: 'error' | 'warning';
  field?: string;                     // product field this is about
  message: string;
  deduct: number;                     // how many points removed (positive number)
};

export type ReadinessResult = {
  target: MarketplaceTarget;
  ready: boolean;
  score: number;                      // 0..100
  issues: ReadinessIssue[];
  error_count: number;
  warning_count: number;
};

/**
 * Minimal product shape this engine needs.
 * Matches what GET /api/products/[sku] returns.
 */
export type ProductForReadiness = {
  master_sku?: string | null;
  product_name_en?: string | null;
  product_name_ar?: string | null;
  brand_id?: number | null;
  category_id?: number | null;
  subcategory_id?: number | null;
  barcode?: string | null;
  price?: number | null;
  stock_quantity?: number | null;
  product_status?: string | null;
  image_url?: string | null;
  description_en?: string | null;
  description_ar?: string | null;
  usage_en?: string | null;
  usage_ar?: string | null;
  keywords_en?: string[] | null;
  keywords_ar?: string[] | null;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const READY_SCORE_THRESHOLD = 90;
const DESCRIPTION_MIN_CHARS = 30;
const MIN_KEYWORDS = 3;

const DEDUCT = {
  // Errors
  missing_name_en: 25,
  missing_name_ar: 20,
  missing_brand: 20,
  missing_category: 20,
  missing_price: 25,
  invalid_stock: 10,
  missing_image: 25,
  missing_sku: 20,
  not_active: 15,
  missing_barcode_shopify: 10,
  missing_category_mapping_talabat: 20,
  missing_name_ar_rafeeq: 25,
  missing_desc_ar_rafeeq: 20,
  // Warnings
  short_desc_en: 8,
  short_desc_ar: 8,
  no_keywords_en: 5,
  no_keywords_ar: 5,
  white_bg_snoonu: 3,
  missing_usage_en: 4,
  missing_usage_ar: 4,
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function len(s: string | null | undefined): number {
  return typeof s === 'string' ? s.trim().length : 0;
}

function nonEmpty(s: string | null | undefined): boolean {
  return len(s) > 0;
}

function error(code: string, message: string, deduct: number, field?: string): ReadinessIssue {
  return { code, severity: 'error', message, deduct, field };
}

function warning(code: string, message: string, deduct: number, field?: string): ReadinessIssue {
  return { code, severity: 'warning', message, deduct, field };
}

// ─── Common rules — apply to every target ────────────────────────────────────

function commonRules(p: ProductForReadiness): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];

  if (!nonEmpty(p.product_name_en)) {
    issues.push(error('MISSING_NAME_EN', 'English product name is required.', DEDUCT.missing_name_en, 'product_name_en'));
  }
  if (!nonEmpty(p.product_name_ar)) {
    issues.push(error('MISSING_NAME_AR', 'Arabic product name is required.', DEDUCT.missing_name_ar, 'product_name_ar'));
  }
  if (!p.brand_id) {
    issues.push(error('MISSING_BRAND', 'Brand must be selected.', DEDUCT.missing_brand, 'brand_id'));
  }
  if (!p.category_id) {
    issues.push(error('MISSING_CATEGORY', 'Category must be selected.', DEDUCT.missing_category, 'category_id'));
  }
  if (!(typeof p.price === 'number' && p.price > 0)) {
    issues.push(error('MISSING_PRICE', 'Price must be greater than 0 QAR.', DEDUCT.missing_price, 'price'));
  }
  if (typeof p.stock_quantity === 'number' && p.stock_quantity < 0) {
    issues.push(error('INVALID_STOCK', 'Stock quantity cannot be negative.', DEDUCT.invalid_stock, 'stock_quantity'));
  }
  if (!nonEmpty(p.image_url)) {
    issues.push(error('MISSING_IMAGE', 'A primary product image is required.', DEDUCT.missing_image, 'image_url'));
  }
  if (!nonEmpty(p.master_sku)) {
    issues.push(error('MISSING_SKU', 'Master SKU is required.', DEDUCT.missing_sku, 'master_sku'));
  }
  if (p.product_status !== 'active') {
    issues.push(error('NOT_ACTIVE', `Product status is "${p.product_status ?? 'unknown'}". Must be "active" to publish.`, DEDUCT.not_active, 'product_status'));
  }

  // Description warnings
  if (len(p.description_en) < DESCRIPTION_MIN_CHARS) {
    issues.push(warning('SHORT_DESC_EN', `English description should be at least ${DESCRIPTION_MIN_CHARS} characters.`, DEDUCT.short_desc_en, 'description_en'));
  }
  if (len(p.description_ar) < DESCRIPTION_MIN_CHARS) {
    issues.push(warning('SHORT_DESC_AR', `Arabic description should be at least ${DESCRIPTION_MIN_CHARS} characters.`, DEDUCT.short_desc_ar, 'description_ar'));
  }

  // Keywords warnings — improve SEO/search recall
  if ((p.keywords_en?.length ?? 0) < MIN_KEYWORDS) {
    issues.push(warning('FEW_KEYWORDS_EN', `Add at least ${MIN_KEYWORDS} English keywords for search.`, DEDUCT.no_keywords_en, 'keywords_en'));
  }
  if ((p.keywords_ar?.length ?? 0) < MIN_KEYWORDS) {
    issues.push(warning('FEW_KEYWORDS_AR', `Add at least ${MIN_KEYWORDS} Arabic keywords for search.`, DEDUCT.no_keywords_ar, 'keywords_ar'));
  }

  return issues;
}

// ─── Per-target rules ────────────────────────────────────────────────────────

const targetRules: Record<MarketplaceTarget, (p: ProductForReadiness) => ReadinessIssue[]> = {
  shopify(p) {
    const issues: ReadinessIssue[] = [];
    if (!nonEmpty(p.barcode)) {
      issues.push(warning(
        'MISSING_BARCODE_SHOPIFY',
        'Shopify recommends a barcode for inventory & marketplace channels.',
        DEDUCT.missing_barcode_shopify,
        'barcode',
      ));
    }
    // Shopify handle is auto-derived from product_name_en on push — not a blocker
    return issues;
  },

  snoonu(p) {
    const issues: ReadinessIssue[] = [];
    // We can't reliably detect white background without image analysis.
    // Surface as a soft warning so the operator double-checks.
    if (nonEmpty(p.image_url)) {
      issues.push(warning(
        'WHITE_BG_SNOONU',
        'Snoonu prefers clean white-background product photos. Verify before publishing.',
        DEDUCT.white_bg_snoonu,
        'image_url',
      ));
    }
    if (!nonEmpty(p.usage_en)) {
      issues.push(warning('MISSING_USAGE_EN', 'Snoonu listings convert better with how-to-use steps.', DEDUCT.missing_usage_en, 'usage_en'));
    }
    return issues;
  },

  talabat(p) {
    const issues: ReadinessIssue[] = [];
    if (!p.category_id) {
      // Already caught in common rules, but Talabat explicitly requires it
      issues.push(error(
        'TALABAT_NO_CATEGORY',
        'Talabat requires an explicit category mapping.',
        DEDUCT.missing_category_mapping_talabat,
        'category_id',
      ));
    }
    return issues;
  },

  rafeeq(p) {
    const issues: ReadinessIssue[] = [];
    // Rafeeq is Arabic-first — escalate AR requirements to errors
    if (!nonEmpty(p.product_name_ar)) {
      issues.push(error(
        'RAFEEQ_NO_NAME_AR',
        'Rafeeq requires the Arabic product name.',
        DEDUCT.missing_name_ar_rafeeq,
        'product_name_ar',
      ));
    }
    if (!nonEmpty(p.description_ar)) {
      issues.push(error(
        'RAFEEQ_NO_DESC_AR',
        'Rafeeq requires an Arabic description.',
        DEDUCT.missing_desc_ar_rafeeq,
        'description_ar',
      ));
    }
    if (!nonEmpty(p.usage_ar)) {
      issues.push(warning('MISSING_USAGE_AR', 'Rafeeq listings benefit from Arabic usage steps.', DEDUCT.missing_usage_ar, 'usage_ar'));
    }
    return issues;
  },
};

// ─── Main validator ──────────────────────────────────────────────────────────

export function checkReadiness(
  product: ProductForReadiness,
  target: MarketplaceTarget,
): ReadinessResult {
  // Combine common + target-specific. De-dupe by code so a rule that fires
  // in both layers only counts once (e.g. MISSING_CATEGORY + TALABAT_NO_CATEGORY).
  const all = [...commonRules(product), ...targetRules[target](product)];
  const seen = new Set<string>();
  const issues: ReadinessIssue[] = [];
  for (const i of all) {
    if (seen.has(i.code)) continue;
    seen.add(i.code);
    issues.push(i);
  }

  const totalDeduction = issues.reduce((sum, i) => sum + i.deduct, 0);
  const score = Math.max(0, Math.min(100, 100 - totalDeduction));

  const error_count = issues.filter((i) => i.severity === 'error').length;
  const warning_count = issues.filter((i) => i.severity === 'warning').length;
  const ready = score >= READY_SCORE_THRESHOLD && error_count === 0;

  return { target, ready, score, issues, error_count, warning_count };
}

/**
 * Color band helper — used by UI badges.
 *   green   90..100
 *   yellow  70..89
 *   red     0..69
 */
export function scoreBand(score: number): 'green' | 'yellow' | 'red' {
  if (score >= 90) return 'green';
  if (score >= 70) return 'yellow';
  return 'red';
}

export const READINESS_PASS_THRESHOLD = READY_SCORE_THRESHOLD;
