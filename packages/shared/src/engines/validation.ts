/**
 * VALIDATION ENGINE — V01..V18 rules with severity.
 */
import type { CleanedRow } from './cleaning';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type ValidationIssue = {
  rule_id: string;
  severity: Severity;
  field: string | null;
  message: string;
  suggested_fix: string | null;
};

export type ValidationContext = {
  existing_master_skus?: Set<string>;
  existing_barcodes?: Set<string>;
  existing_brand_name_size?: Set<string>;
  known_brands?: Set<string>;
  max_price?: number;
};

export function validateCleanedRow(row: CleanedRow, ctx: ValidationContext = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const maxPrice = ctx.max_price ?? 50000;

  if (!row.brand_raw) {
    issues.push({
      rule_id: 'V02', severity: 'high', field: 'brand',
      message: 'Brand is missing.',
      suggested_fix: 'Add the brand to the row before importing.',
    });
  } else if (ctx.known_brands && !ctx.known_brands.has(row.brand_raw)) {
    issues.push({
      rule_id: 'V02', severity: 'medium', field: 'brand',
      message: `Brand "${row.brand_raw}" is not in the brands table.`,
      suggested_fix: 'Add the brand via /settings/brands or correct the spelling.',
    });
  }

  if (!row.product_name_en || row.product_name_en.length < 3) {
    issues.push({
      rule_id: 'V03', severity: 'critical', field: 'product_name_en',
      message: 'English product name is missing or too short.',
      suggested_fix: 'Provide a proper English name.',
    });
  }

  if (!row.product_name_ar || row.product_name_ar.length < 3) {
    issues.push({
      rule_id: 'V04', severity: 'high', field: 'product_name_ar',
      message: 'Arabic product name is missing or too short.',
      suggested_fix: 'Provide an Arabic name.',
    });
  } else if (!/[؀-ۿ]/.test(row.product_name_ar)) {
    issues.push({
      rule_id: 'V04', severity: 'high', field: 'product_name_ar',
      message: 'Arabic name does not contain Arabic characters.',
      suggested_fix: 'Translate to Arabic.',
    });
  }

  if (row.price == null) {
    issues.push({
      rule_id: 'V05', severity: 'critical', field: 'price',
      message: 'Price is missing or unparseable.',
      suggested_fix: 'Enter a numeric price in QAR.',
    });
  } else if (row.price <= 0) {
    issues.push({
      rule_id: 'V05', severity: 'critical', field: 'price',
      message: 'Price must be greater than 0.',
      suggested_fix: 'Set the correct price.',
    });
  } else if (row.price > maxPrice) {
    issues.push({
      rule_id: 'V05', severity: 'high', field: 'price',
      message: `Price ${row.price} exceeds the sanity bound of ${maxPrice} QAR.`,
      suggested_fix: 'Confirm this is intentional, or fix the typo.',
    });
  }

  if (row.discount_price != null && row.price != null && row.discount_price >= row.price) {
    issues.push({
      rule_id: 'V18', severity: 'medium', field: 'discount_price',
      message: 'Discount price is not lower than regular price.',
      suggested_fix: 'Remove the discount or set it below the regular price.',
    });
  }

  if (!Number.isInteger(row.stock_quantity) || row.stock_quantity < 0) {
    issues.push({
      rule_id: 'V06', severity: 'high', field: 'stock_quantity',
      message: 'Stock quantity must be a non-negative integer.',
      suggested_fix: 'Set stock to 0 or a positive number.',
    });
  }

  if (row.barcode && !/^\d{12,14}$/.test(row.barcode)) {
    issues.push({
      rule_id: 'V11', severity: 'low', field: 'barcode',
      message: 'Barcode does not match EAN-13 / UPC-A / GTIN-14 format.',
      suggested_fix: 'Verify the barcode or leave blank.',
    });
  }

  if (row.barcode && ctx.existing_barcodes?.has(row.barcode)) {
    issues.push({
      rule_id: 'V13', severity: 'high', field: 'barcode',
      message: `Barcode ${row.barcode} already exists.`,
      suggested_fix: 'Confirm same product (merge) or correct barcode.',
    });
  }

  if (row.brand_raw && row.product_name_en) {
    const key = `${row.brand_raw}|${row.product_name_en.toLowerCase()}|${row.size ?? ''}`;
    if (ctx.existing_brand_name_size?.has(key)) {
      issues.push({
        rule_id: 'V14', severity: 'medium', field: 'product_name_en',
        message: 'Another product with same brand, name, and size exists.',
        suggested_fix: 'Confirm intentional duplicate, or merge with existing.',
      });
    }
  }

  if (row.description_en && row.description_en.length < 20) {
    issues.push({
      rule_id: 'V15', severity: 'low', field: 'description_en',
      message: 'English description is shorter than 20 characters.',
      suggested_fix: 'Add 2-4 lines of benefit-led content.',
    });
  }

  if (row.description_ar && row.description_ar.length < 20) {
    issues.push({
      rule_id: 'V16', severity: 'low', field: 'description_ar',
      message: 'Arabic description is shorter than 20 characters.',
      suggested_fix: 'Add an Arabic version of the description.',
    });
  }

  if (!row.image_url) {
    issues.push({
      rule_id: 'V09', severity: 'high', field: 'image_url',
      message: 'No primary image URL provided.',
      suggested_fix: 'Add an image URL or upload one after import.',
    });
  }

  return issues;
}

export function worstSeverity(issues: ValidationIssue[]): Severity | null {
  if (issues.length === 0) return null;
  const order: Severity[] = ['critical', 'high', 'medium', 'low'];
  for (const s of order) {
    if (issues.some((i) => i.severity === s)) return s;
  }
  return null;
}

export function statusFromIssues(issues: ValidationIssue[]): 'blocked' | 'draft' | 'active' {
  const worst = worstSeverity(issues);
  if (worst === 'critical') return 'blocked';
  if (worst === 'high') return 'draft';
  return 'active';
}

export function summarizeIssues(issues: ValidationIssue[]): Record<Severity, number> {
  return {
    critical: issues.filter((i) => i.severity === 'critical').length,
    high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    low: issues.filter((i) => i.severity === 'low').length,
  };
}
