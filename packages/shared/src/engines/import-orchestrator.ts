/**
 * IMPORT ORCHESTRATOR — chains parse → clean → classify → validate → match.
 */
import { type FieldMapping, type CleanedRow, cleanRow } from './cleaning';
import { type CategoryDecision, type CategoryRuleSet, classifyProduct } from './category';
import {
  type ValidationContext, type ValidationIssue, validateCleanedRow,
  statusFromIssues, summarizeIssues,
} from './validation';
import {
  type MatchableProduct, type PlatformMatchDecision, decidePlatformMatch, matchAgainst,
} from './matching';

export type StagedRow = {
  raw_index: number;
  cleaned: CleanedRow;
  brand_id: number | null;
  category: CategoryDecision;
  validation: {
    issues: ValidationIssue[];
    summary: ReturnType<typeof summarizeIssues>;
    status: 'blocked' | 'draft' | 'active';
  };
  matches: PlatformMatchDecision[];
  decision: 'auto_import' | 'review_required' | 'block';
  decision_reason: string;
};

export type ImportPreview = {
  total_rows: number;
  staged: StagedRow[];
  summary: {
    auto_import: number;
    review_required: number;
    blocked: number;
    critical_issues: number;
    high_issues: number;
    medium_issues: number;
    low_issues: number;
    will_create_new: number;
    will_match_existing: number;
  };
};

export type OrchestrateInput = {
  raw_rows: Array<Record<string, unknown>>;
  mapping: FieldMapping;
  source_platform: CleanedRow['source_platform'];
  brand_lookup: Map<string, number>;
  category_rules: CategoryRuleSet;
  validation_context: ValidationContext;
  match_candidates: {
    shopify: MatchableProduct[];
    talabat: MatchableProduct[];
    rafeeq: MatchableProduct[];
    old_master: MatchableProduct[];
  };
};

export function orchestrate(input: OrchestrateInput): ImportPreview {
  const staged: StagedRow[] = input.raw_rows.map((raw, i) => {
    const cleaned = cleanRow(raw, input.mapping, i, input.source_platform);
    const brand_id = input.brand_lookup.get(cleaned.brand_raw) ?? null;

    const category = classifyProduct(
      {
        product_name_en: cleaned.product_name_en,
        product_name_ar: cleaned.product_name_ar,
        brand_raw: cleaned.brand_raw,
        category_hint: cleaned.category_hint,
      },
      input.category_rules,
    );

    const issues = validateCleanedRow(cleaned, input.validation_context);
    const status = statusFromIssues(issues);

    const source: MatchableProduct = {
      snoonu_sku: cleaned.snoonu_sku,
      barcode: cleaned.barcode,
      brand_name: cleaned.brand_raw,
      product_name_en: cleaned.product_name_en,
      product_name_ar: cleaned.product_name_ar,
      size: cleaned.size,
      variant: cleaned.variant,
      color: cleaned.color,
      price: cleaned.price,
    };

    const matches: PlatformMatchDecision[] = [
      decidePlatformMatch('shopify', topMatch(source, input.match_candidates.shopify)),
      decidePlatformMatch('talabat', topMatch(source, input.match_candidates.talabat)),
      decidePlatformMatch('rafeeq', topMatch(source, input.match_candidates.rafeeq)),
      decidePlatformMatch('old_master', topMatch(source, input.match_candidates.old_master)),
    ];

    const decision = computeDecision(status, category, matches);

    return {
      raw_index: cleaned.raw_index,
      cleaned,
      brand_id,
      category,
      validation: { issues, summary: summarizeIssues(issues), status },
      matches,
      decision: decision.tag,
      decision_reason: decision.reason,
    };
  });

  const summary = {
    auto_import: staged.filter((s) => s.decision === 'auto_import').length,
    review_required: staged.filter((s) => s.decision === 'review_required').length,
    blocked: staged.filter((s) => s.decision === 'block').length,
    critical_issues: sum(staged, (s) => s.validation.summary.critical),
    high_issues: sum(staged, (s) => s.validation.summary.high),
    medium_issues: sum(staged, (s) => s.validation.summary.medium),
    low_issues: sum(staged, (s) => s.validation.summary.low),
    will_create_new: staged.filter((s) => s.matches.every((m) => m.status === 'missing')).length,
    will_match_existing: staged.filter((s) => s.matches.some((m) => m.status === 'matched_auto')).length,
  };

  return { total_rows: staged.length, staged, summary };
}

function topMatch(
  source: MatchableProduct,
  candidates: MatchableProduct[],
): { candidate: MatchableProduct; result: ReturnType<typeof matchAgainst>[number]['result'] } | null {
  if (candidates.length === 0) return null;
  const ranked = matchAgainst(source, candidates, { minScore: 30, topK: 1 });
  return ranked[0] ?? null;
}

function computeDecision(
  status: ReturnType<typeof statusFromIssues>,
  category: CategoryDecision,
  matches: PlatformMatchDecision[],
): { tag: StagedRow['decision']; reason: string } {
  if (status === 'blocked') return { tag: 'block', reason: 'Critical validation errors must be fixed.' };
  if (category.needs_review || category.confidence < 0.7) {
    return { tag: 'review_required', reason: 'Category falls back or low confidence.' };
  }
  if (matches.some((m) => m.status === 'matched_review')) {
    return { tag: 'review_required', reason: 'Cross-platform match below auto threshold.' };
  }
  if (status === 'draft') return { tag: 'review_required', reason: 'High-severity validation issues present.' };
  return { tag: 'auto_import', reason: 'All checks passed.' };
}

function sum<T>(arr: T[], fn: (t: T) => number): number {
  return arr.reduce((acc, x) => acc + fn(x), 0);
}
