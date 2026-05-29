/**
 * Snoonu section parser + matcher — Phase 13D.8.
 *
 * Two pieces of pure logic:
 *
 *   1. parseSnoonuCatalogPage(rawText)
 *      → array of detected catalog sections + product counts
 *
 *   2. matchProductToSection({ category_name, brand, name_en, ... }, availableSections)
 *      → the best matching section name + confidence score + reason
 *
 * The matcher NEVER invents a section — it only picks from the list of
 * sections that were actually scraped from Snoonu's catalog page. If no
 * acceptable match exists, it returns null (UI flags row as needs_review).
 */

// ─── Parser ─────────────────────────────────────────────────────────────────

export type ParsedSection = {
  name_en: string;
  product_count: number | null;
  raw_line: string;
};

/**
 * Stop tokens — common UI text we DON'T want to capture as a section.
 * Tuned to Snoonu seller portal's catalog overview page.
 */
const STOP_TOKENS = new Set([
  'home', 'menu', 'catalog', 'catalogs', 'sections', 'section',
  'sort', 'filter', 'search', 'next', 'previous', 'page',
  'edit', 'save', 'delete', 'add', 'add new', 'add catalog', 'add section',
  'product', 'products', 'item', 'items',
  'visible', 'hidden', 'active', 'inactive',
  'view', 'preview', 'publish', 'unpublish',
  'logout', 'profile', 'settings', 'help',
  'arabic', 'english', 'ar', 'en',
  'qa', 'qatar',
]);

function looksLikeSectionName(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^https?:/i.test(t)) return false;
  if (/@/.test(t)) return false;
  // Reject lines that are pure punctuation or symbols
  if (!/[A-Za-z؀-ۿ]/.test(t)) return false;
  // Reject obvious UI text
  if (STOP_TOKENS.has(t.toLowerCase())) return false;
  // Reject lines that look like "N products" alone
  if (/^\d+\s*(products?|items?)\s*$/i.test(t)) return false;
  return true;
}

/**
 * Parse a Snoonu catalog overview page's raw text into a list of sections.
 *
 * Recognizes these patterns:
 *   - "Hair Care\n45 products"
 *   - "Hair Care 45 products"
 *   - "Hair Care (45)"
 *   - "Hair Care • 45"
 *   - "Hair Care"  (no count)
 */
export function parseSnoonuCatalogPage(rawText: string): ParsedSection[] {
  if (!rawText) return [];

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const sections: ParsedSection[] = [];
  const seen = new Set<string>();

  function add(name: string, count: number | null, raw: string) {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    sections.push({ name_en: name, product_count: count, raw_line: raw });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern: "Name (N)" or "Name (N products)"
    const parenMatch = line.match(/^(.+?)\s*\((\d+)(?:\s*(?:products?|items?))?\)\s*$/i);
    if (parenMatch && looksLikeSectionName(parenMatch[1])) {
      add(parenMatch[1].trim(), parseInt(parenMatch[2], 10), line);
      continue;
    }

    // Pattern: "Name • N" or "Name | N" or "Name · N"
    const bulletMatch = line.match(/^(.+?)\s*[•|·]\s*(\d+)\s*(?:products?|items?)?\s*$/i);
    if (bulletMatch && looksLikeSectionName(bulletMatch[1])) {
      add(bulletMatch[1].trim(), parseInt(bulletMatch[2], 10), line);
      continue;
    }

    // Pattern: "Name N products" (inline)
    const inlineMatch = line.match(/^(.+?)\s+(\d+)\s+(?:products?|items?)\s*$/i);
    if (inlineMatch && looksLikeSectionName(inlineMatch[1])) {
      add(inlineMatch[1].trim(), parseInt(inlineMatch[2], 10), line);
      continue;
    }

    // Pattern: Name on its own line + "N products" on next line
    if (looksLikeSectionName(line) && i + 1 < lines.length) {
      const next = lines[i + 1];
      const nextCount = next.match(/^(\d+)\s*(?:products?|items?)\s*$/i);
      if (nextCount) {
        add(line, parseInt(nextCount[1], 10), `${line} | ${next}`);
        i++; // consume the count line
        continue;
      }
    }

    // Pattern: bare section name on its own line
    if (looksLikeSectionName(line)) {
      add(line, null, line);
    }
  }

  return sections;
}

// ─── Matcher ────────────────────────────────────────────────────────────────

export type AvailableSection = {
  catalog_name_en: string;
};

export type MatchInput = {
  category_name?: string | null;       // detected canonical category (e.g. "Korean Skincare")
  brand?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  product_type?: string | null;
  keywords?: string | null;
};

export type SectionMatch = {
  section_name: string;
  confidence: number;
  reason: string;
} | null;

// ─── Mapping rules (deterministic, ordered) ────────────────────────────────

/**
 * Category → preferred Snoonu section name. We match by lowercased equality
 * AGAINST THE ACTUAL SECTIONS THAT WERE SCRAPED — so if Snoonu doesn't have
 * "Face Care", the Korean Skincare rule falls through to the next attempt.
 */
const CATEGORY_TO_SECTION: Array<{ category: string; section: string; confidence: number }> = [
  // Direct matches
  { category: 'Hair Care', section: 'Hair Care', confidence: 1.0 },
  { category: 'Makeup', section: 'Makeup', confidence: 1.0 },
  { category: 'Body Care', section: 'Body Care', confidence: 1.0 },
  // Aliased
  { category: 'Korean Skincare', section: 'Face Care', confidence: 0.95 },
  { category: 'Beauty Tools', section: 'Beauty Accessories', confidence: 0.9 },
  { category: 'Nail Care', section: 'Lashes & Nails', confidence: 0.95 },
  { category: 'Gifts & Sets', section: 'Gifts & Special Occasions', confidence: 0.9 },
  // Lower-confidence — Snoonu has no dedicated perfume section
  { category: 'Perfumes', section: 'Beauty Accessories', confidence: 0.6 },
  { category: 'Bags & Accessories', section: 'Beauty Accessories', confidence: 0.7 },
  // Special
  { category: 'Kids & Toys', section: 'Toys', confidence: 0.95 },
  { category: 'Thai Products', section: 'Thailand Products', confidence: 1.0 },
];

/** Brand → section overrides (highest priority). */
const BRAND_OVERRIDES: Array<{ brand_substring: string; section: string; confidence: number }> = [
  { brand_substring: 'rhode', section: 'Rhode Products Section', confidence: 1.0 },
];

/** Name keyword overrides — applied before category mapping. */
const KEYWORD_RULES: Array<{ regex: RegExp; section: string; confidence: number; reason: string }> = [
  { regex: /\b(sunscreen|spf|sun\s*protection|uv\s*protect|sunblock)\b/i, section: 'Sun Protection', confidence: 0.95, reason: 'keyword:sunscreen' },
  { regex: /\b(sheet\s*mask|face\s*mask|sleeping\s*mask|clay\s*mask|wash[-\s]?off\s*mask)\b/i, section: 'Masks', confidence: 0.92, reason: 'keyword:mask' },
  { regex: /\b(dental|toothpaste|toothbrush|mouthwash|whitening\s*strips)\b/i, section: 'Dental Care', confidence: 1.0, reason: 'keyword:dental' },
  { regex: /\b(electronic|charger|cable|power\s*bank|usb)\b/i, section: 'Electronics', confidence: 0.85, reason: 'keyword:electronics' },
  { regex: /\b(eid|ramadan)\b/i, section: 'Eid Specials', confidence: 0.95, reason: 'keyword:eid' },
  { regex: /\b(camping|tent|outdoor\s*gear)\b/i, section: 'Summer And Camping Supplies', confidence: 0.9, reason: 'keyword:camping' },
  { regex: /\b(toy|doll|plush|labubu)\b/i, section: 'Toys', confidence: 0.95, reason: 'keyword:toy' },
  { regex: /\b(women|woman|feminine\s*hygiene|menstrual|pads|tampons)\b/i, section: "Women's Essentials", confidence: 0.85, reason: 'keyword:women' },
  { regex: /\b(gift\s*set|gift\s*bundle|hamper|combo\s*pack)\b/i, section: 'Beauty Bundle', confidence: 0.9, reason: 'keyword:bundle' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function clean(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toLowerCase();
}

function fuzzyContains(haystack: string, needle: string): boolean {
  const h = clean(haystack);
  const n = clean(needle);
  if (!h || !n) return false;
  return h.includes(n);
}

function sectionExists(target: string, available: AvailableSection[]): string | null {
  // Case-insensitive exact match first
  const targetLc = clean(target);
  for (const s of available) {
    if (clean(s.catalog_name_en) === targetLc) return s.catalog_name_en;
  }
  // Fuzzy contains either direction
  for (const s of available) {
    if (fuzzyContains(s.catalog_name_en, target) || fuzzyContains(target, s.catalog_name_en)) {
      return s.catalog_name_en;
    }
  }
  return null;
}

// ─── Main entry ────────────────────────────────────────────────────────────

export function matchProductToSection(
  input: MatchInput,
  availableSections: AvailableSection[],
): SectionMatch {
  if (!availableSections || availableSections.length === 0) return null;

  const blob = [input.name_en, input.product_type, input.keywords]
    .filter(Boolean)
    .join(' ');

  // ─── Pass 1: brand override (highest trust) ─────────────────────────────
  const brandLc = clean(input.brand);
  if (brandLc) {
    for (const rule of BRAND_OVERRIDES) {
      if (brandLc.includes(rule.brand_substring)) {
        const resolved = sectionExists(rule.section, availableSections);
        if (resolved) {
          return {
            section_name: resolved,
            confidence: rule.confidence,
            reason: `brand:${rule.brand_substring}`,
          };
        }
      }
    }
  }

  // ─── Pass 2: keyword override ────────────────────────────────────────────
  if (blob) {
    for (const rule of KEYWORD_RULES) {
      if (rule.regex.test(blob)) {
        const resolved = sectionExists(rule.section, availableSections);
        if (resolved) {
          return { section_name: resolved, confidence: rule.confidence, reason: rule.reason };
        }
      }
    }
  }

  // ─── Pass 3: category → section mapping ─────────────────────────────────
  const cat = clean(input.category_name);
  if (cat) {
    for (const rule of CATEGORY_TO_SECTION) {
      if (clean(rule.category) === cat) {
        const resolved = sectionExists(rule.section, availableSections);
        if (resolved) {
          return {
            section_name: resolved,
            confidence: rule.confidence,
            reason: `category:${rule.category}→${rule.section}`,
          };
        }
      }
    }
  }

  // ─── Pass 4: name contains section name (fuzzy bidirectional) ────────────
  if (blob) {
    const blobLc = clean(blob);
    for (const s of availableSections) {
      const sectionLc = clean(s.catalog_name_en);
      // e.g. product name "Hair Care Shampoo" + section "Hair Care"
      if (blobLc.includes(sectionLc) && sectionLc.length >= 4) {
        return {
          section_name: s.catalog_name_en,
          confidence: 0.75,
          reason: `name_contains_section:${s.catalog_name_en}`,
        };
      }
    }
  }

  // Nothing matched
  return null;
}

/**
 * Bulk wrapper: match an array of products against the section list.
 * Returns parallel array of match results.
 */
export function bulkMatch(
  products: MatchInput[],
  sections: AvailableSection[],
): SectionMatch[] {
  return products.map((p) => matchProductToSection(p, sections));
}
