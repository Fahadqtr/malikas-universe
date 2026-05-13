/**
 * CATEGORY ENGINE — assigns each product to main + sub category.
 * Pure logic. Caller injects rule sets.
 */
import { CATEGORY_CODES, type MainCategory } from '../types/product';
import { stripDiacritics } from '../utils/arabic';

export type BrandRule = {
  brand_id: number;
  brand_name: string;
  category_id: number;
  category_name: MainCategory;
  default_subcategory_id: number | null;
  default_subcategory_name: string | null;
  confidence: number;
};

export type KeywordRule = {
  keyword: string;
  language: 'en' | 'ar';
  category_id: number;
  category_name: MainCategory;
  subcategory_id: number | null;
  subcategory_name: string | null;
  confidence: number;
};

export type CategoryHintRule = {
  hint: string;
  category_id: number;
  category_name: MainCategory;
};

export type CategoryRuleSet = {
  brandRules: Map<string, BrandRule>;
  keywordRules: KeywordRule[];
  categoryHints: Map<string, CategoryHintRule>;
  fallbackCategoryId: number;
};

export type CategoryDecision = {
  category_id: number;
  category_name: MainCategory;
  subcategory_id: number | null;
  subcategory_name: string | null;
  product_type: string | null;
  confidence: number;
  rule_applied: 'brand' | 'keyword_en' | 'keyword_ar' | 'category_hint' | 'fallback';
  matched_value: string | null;
  needs_review: boolean;
};

export type ClassifyInput = {
  product_name_en?: string;
  product_name_ar?: string;
  brand_raw?: string;
  product_type?: string | null;
  category_hint?: string | null;
};

export function classifyProduct(input: ClassifyInput, rules: CategoryRuleSet): CategoryDecision {
  if (input.brand_raw) {
    const brandRule = rules.brandRules.get(input.brand_raw);
    if (brandRule) {
      const sub = findSubcategoryByKeyword(input, rules, brandRule.category_id);
      return {
        category_id: brandRule.category_id,
        category_name: brandRule.category_name,
        subcategory_id: sub?.subcategory_id ?? brandRule.default_subcategory_id,
        subcategory_name: sub?.subcategory_name ?? brandRule.default_subcategory_name,
        product_type: sub?.matched_value ?? null,
        confidence: brandRule.confidence,
        rule_applied: 'brand',
        matched_value: brandRule.brand_name,
        needs_review: false,
      };
    }
  }

  const haystackEn = `${input.product_name_en ?? ''} ${input.product_type ?? ''}`.toLowerCase();
  const haystackAr = stripDiacritics(input.product_name_ar ?? '').toLowerCase();
  const enHit = scanKeywords(haystackEn, rules.keywordRules, 'en');
  const arHit = scanKeywords(haystackAr, rules.keywordRules, 'ar');
  const bestKeyword = pickBestKeywordHit(enHit, arHit);

  if (bestKeyword) {
    return {
      category_id: bestKeyword.category_id,
      category_name: bestKeyword.category_name,
      subcategory_id: bestKeyword.subcategory_id,
      subcategory_name: bestKeyword.subcategory_name,
      product_type: bestKeyword.keyword,
      confidence: bestKeyword.confidence,
      rule_applied: bestKeyword.language === 'en' ? 'keyword_en' : 'keyword_ar',
      matched_value: bestKeyword.keyword,
      needs_review: false,
    };
  }

  if (input.category_hint) {
    const hintKey = input.category_hint.toLowerCase().trim();
    const hintRule = rules.categoryHints.get(hintKey);
    if (hintRule) {
      return {
        category_id: hintRule.category_id,
        category_name: hintRule.category_name,
        subcategory_id: null,
        subcategory_name: null,
        product_type: null,
        confidence: 0.85,
        rule_applied: 'category_hint',
        matched_value: hintKey,
        needs_review: true,
      };
    }
  }

  return {
    category_id: rules.fallbackCategoryId,
    category_name: 'Trending Products',
    subcategory_id: null,
    subcategory_name: null,
    product_type: null,
    confidence: 0,
    rule_applied: 'fallback',
    matched_value: null,
    needs_review: true,
  };
}

const CATEGORY_PRIORITY: Record<MainCategory, number> = {
  'Korean Skincare': 1,
  'Thai Products': 2,
  'Hair Care': 3,
  Makeup: 4,
  'Body Care': 5,
  Perfumes: 6,
  'Beauty Tools': 7,
  'Bags & Accessories': 8,
  'Gifts & Sets': 9,
  'Kids & Toys': 10,
  'Trending Products': 99,
};

function scanKeywords(haystack: string, rules: KeywordRule[], language: 'en' | 'ar'): KeywordRule | null {
  if (!haystack) return null;
  const candidates: KeywordRule[] = [];
  for (const rule of rules) {
    if (rule.language !== language) continue;
    const matched =
      language === 'en'
        ? new RegExp(`\\b${escapeRegex(rule.keyword)}\\b`).test(haystack)
        : haystack.includes(rule.keyword);
    if (matched) candidates.push(rule);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.keyword.length - a.keyword.length);
  return candidates[0]!;
}

function pickBestKeywordHit(en: KeywordRule | null, ar: KeywordRule | null): KeywordRule | null {
  if (!en && !ar) return null;
  if (!en) return ar;
  if (!ar) return en;
  return CATEGORY_PRIORITY[en.category_name] <= CATEGORY_PRIORITY[ar.category_name] ? en : ar;
}

function findSubcategoryByKeyword(
  input: ClassifyInput,
  rules: CategoryRuleSet,
  categoryId: number,
): { subcategory_id: number | null; subcategory_name: string | null; matched_value: string | null } | null {
  const haystack = `${input.product_name_en ?? ''} ${input.product_type ?? ''}`.toLowerCase();
  if (!haystack) return null;

  const candidates = rules.keywordRules.filter(
    (r) => r.category_id === categoryId && r.subcategory_id != null && r.language === 'en',
  );
  for (const c of candidates.sort((a, b) => b.keyword.length - a.keyword.length)) {
    if (new RegExp(`\\b${escapeRegex(c.keyword)}\\b`).test(haystack)) {
      return {
        subcategory_id: c.subcategory_id,
        subcategory_name: c.subcategory_name,
        matched_value: c.keyword,
      };
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function codeForCategory(name: MainCategory): string {
  return CATEGORY_CODES[name];
}
