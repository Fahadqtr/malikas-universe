/**
 * Marketplace export validator.
 *
 * Given a list of products + a target platform, returns:
 *   • eligible[]   — products that pass all required-field checks
 *   • blocked[]    — products that fail, with per-field reasons
 *
 * Pure module. No DB calls. No side effects.
 *
 * Rule of thumb:
 *   • product_status MUST be 'active' (caller is expected to filter first,
 *     but we double-check here as a safety belt)
 *   • Each platform template defines its own required columns
 *   • A missing required field → block + reason
 *   • A column that returns `null`/empty string for required → block
 */

import {
  buildRow,
  getTemplate,
  type ExportTarget,
  type SourceProduct,
} from './export-templates';

export type BlockedReason = {
  field: string;
  header: string;
  message: string;
};

export type ValidationOutcome = {
  target: ExportTarget;
  total: number;
  eligible_count: number;
  blocked_count: number;
  eligible: SourceProduct[];
  blocked: Array<{
    master_sku: string;
    product_name_en?: string | null;
    product_name_ar?: string | null;
    reasons: BlockedReason[];
  }>;
};

const REQUIRED_NON_ACTIVE_REASON: BlockedReason = {
  field: 'product_status',
  header: 'Status',
  message: 'Product must be approved (status = active) before export.',
};

/**
 * Check a single product against a platform template.
 * Returns an array of failure reasons (empty = passes).
 */
export function checkProduct(
  product: SourceProduct & { product_status?: string | null },
  target: ExportTarget,
): BlockedReason[] {
  const reasons: BlockedReason[] = [];

  // Hard gate: status must be active
  if (product.product_status !== 'active') {
    reasons.push({
      ...REQUIRED_NON_ACTIVE_REASON,
      message: `Product status is "${product.product_status ?? 'unknown'}". Must be "active".`,
    });
    return reasons; // no need to check anything else
  }

  const template = getTemplate(target);
  const row = buildRow(template, product);

  for (let i = 0; i < template.columns.length; i++) {
    const col = template.columns[i];
    if (!col.required) continue;

    const v = row[i];
    const isEmpty =
      v === null ||
      v === undefined ||
      (typeof v === 'string' && v.trim() === '') ||
      (typeof v === 'number' && col.field === 'price' && v <= 0);

    if (isEmpty) {
      reasons.push({
        field: col.field,
        header: col.header,
        message: col.hint ?? `${col.header} is required for ${template.label}.`,
      });
    }
  }

  return reasons;
}

/**
 * Validate a batch of products. Returns split into eligible / blocked.
 */
export function validateBatch(
  products: Array<SourceProduct & { product_status?: string | null }>,
  target: ExportTarget,
): ValidationOutcome {
  const eligible: SourceProduct[] = [];
  const blocked: ValidationOutcome['blocked'] = [];

  for (const p of products) {
    const reasons = checkProduct(p, target);
    if (reasons.length === 0) {
      eligible.push(p);
    } else {
      blocked.push({
        master_sku: p.master_sku,
        product_name_en: p.product_name_en,
        product_name_ar: p.product_name_ar,
        reasons,
      });
    }
  }

  return {
    target,
    total: products.length,
    eligible_count: eligible.length,
    blocked_count: blocked.length,
    eligible,
    blocked,
  };
}
