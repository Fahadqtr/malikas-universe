/**
 * Snoonu Category Inferrer — Phase 13F.17.
 *
 * Given a product (name EN/AR, description EN/AR, brand, price), infer the
 * single Snoonu catalog section it most likely belongs to. Returns the
 * predicted section + confidence score 0.00–1.00 + the matched signals.
 *
 * Deterministic classifier — no LLM call. Built from:
 *   1. Brand → section overrides (highest priority)
 *   2. Strong keyword rules (high confidence)
 *   3. Type keyword rules (medium confidence)
 *   4. Multi-signal aggregation (boost when multiple weak signals agree)
 *
 * Confidence tiers (caller decides what to do):
 *   - ≥ 0.85: auto-apply (high trust)
 *   - 0.70–0.84: save as suggestion + needs_review
 *   - < 0.70:    no apply, send back to browser audit queue
 *
 * Returns null when no section can be predicted with any reasonable signal.
 */

// ─── The 19 real Snoonu catalog sections ───────────────────────────────────

export const SNOONU_SECTIONS = [
  'Eid Specials',
  'Hair Care',
  'Face Care',
  'Sun Protection',
  'Masks',
  'Body Care',
  'Dental Care',
  'Beauty Accessories',
  'Beauty Bundle',
  'Makeup',
  'Lashes & Nails',
  'Summer And Camping Supplies',
  'Toys',
  'Rhode Products Section',
  'Electronics',
  "Women's Essentials",
  'Gifts & Special Occasions',
  'Thailand Products',
  'Labubu Collection',
] as const;

export type SnoonuSection = (typeof SNOONU_SECTIONS)[number];

// ─── Types ─────────────────────────────────────────────────────────────────

export type InferrerInput = {
  name_en?: string | null;
  name_ar?: string | null;
  description_en?: string | null;
  description_ar?: string | null;
  brand?: string | null;
  price?: number | null;
};

export type InferrerHit = {
  section: SnoonuSection;
  confidence: number;
  signals: string[];
  rationale: string;
};

// ─── Brand rules (very high confidence — usually 1.0) ─────────────────────

type BrandRule = { brand: RegExp; section: SnoonuSection; conf: number; label: string };
const BRAND_RULES: BrandRule[] = [
  { brand: /\brhode\b/i,                  section: 'Rhode Products Section', conf: 1.0, label: 'brand:rhode' },
  { brand: /\blabubu\b|\bla\s*bobo\b/i,    section: 'Labubu Collection',      conf: 1.0, label: 'brand:labubu' },
];

// ─── Strong keyword rules (confidence 0.92–0.95) ──────────────────────────
// Order matters — first match wins. Most specific first.

type KeywordRule = { pattern: RegExp; section: SnoonuSection; conf: number; label: string };
const STRONG_RULES: KeywordRule[] = [
  // Eid / Ramadan specials
  { pattern: /\b(eid|ramadan)\b/i,                section: 'Eid Specials',        conf: 0.92, label: 'kw:eid' },

  // Labubu accessories that don't say "Labubu" in name (rare — caught by brand above usually)
  { pattern: /\bdoll(\s|s\s)?(outfit|sweater|clothes|crocs|hat|set)/i, section: 'Labubu Collection', conf: 0.85, label: 'kw:doll_outfit' },

  // Dental
  { pattern: /\b(toothpaste|toothbrush|whitening\s*strips?|mouthwash|dental\s+(care|kit|whitening)|teeth\s+whitening|whitening\s+kit|whitening\s+powder|whitening\s+strips?)\b/i,
    section: 'Dental Care', conf: 0.95, label: 'kw:dental_strong' },
  { pattern: /\b(oral[-\s]?b|colgate|crest|sensodyne|euthymol)\b/i,
    section: 'Dental Care', conf: 0.95, label: 'brand:dental' },

  // Sun protection
  { pattern: /\b(sunscreen|sun\s*cream|sun\s*stick|sun\s*gel|sun\s*serum|spf\s*\d{2,3}\+?|spf[-\s]?50|sun\s*block)\b/i,
    section: 'Sun Protection', conf: 0.95, label: 'kw:sunscreen' },

  // Masks — but only "face mask" / "sheet mask" / etc, NOT "lift band" or "hair mask"
  { pattern: /\b(sheet\s*mask|face\s*mask|sleeping\s*mask|hydrogel\s*mask|clay\s*mask|peel[-\s]?off\s*mask|collagen\s*mask|patch\s*mask|nasolabial\s*folds?\s*patch)\b/i,
    section: 'Masks', conf: 0.92, label: 'kw:face_mask' },
  { pattern: /\bbio\s*collagen\s*(deep)?\s*(face)?\s*mask\b/i,
    section: 'Masks', conf: 0.95, label: 'kw:bio_collagen_mask' },

  // Hair care
  { pattern: /\b(shampoo|conditioner|hair\s*mask|hair\s*oil|hair\s*serum|hair\s*spray|hair\s*styling|dry\s*shampoo|scalp\s*(serum|treatment|massage)|leave[-\s]?in|hair\s*growth|hair\s*tonic|hair\s*cream|wide[-\s]?tooth\s*comb|hair\s*lift\s*tape|hair\s*volume|root\s*boost|hair\s*styling\s*cream|hair\s*brush|hair\s*tools?|heat\s*protectant)\b/i,
    section: 'Hair Care', conf: 0.92, label: 'kw:hair_care' },
  { pattern: /\b(k18|olaplex|kerastase|tsubaki|fino\s+(premium\s+)?touch)\b/i,
    section: 'Hair Care', conf: 0.95, label: 'brand:hair' },

  // Makeup
  { pattern: /\b(lipstick|lip\s*gloss|lip\s*oil|lip\s*tint|lip\s*stain|lip\s*liner|lip\s*balm|lip\s*plumper)\b/i,
    section: 'Makeup', conf: 0.93, label: 'kw:lip' },
  { pattern: /\b(foundation|concealer|blush(?:\s*stick)?|highlighter|bronzer|contour|primer|setting\s*spray|setting\s*powder|loose\s*powder|compact\s*powder|bb\s*cream|cc\s*cream|tinted\s*moisturizer)\b/i,
    section: 'Makeup', conf: 0.93, label: 'kw:face_makeup' },
  { pattern: /\b(eyeliner|eyeshadow|mascara|brow\s*(pencil|tint|gel|filler|pen)|eyebrow\s*(pencil|tint|pen)|2-?in-?1\s*lip\s*&?\s*brow\s*tint)\b/i,
    section: 'Makeup', conf: 0.92, label: 'kw:eye_makeup' },

  // Lashes & Nails
  { pattern: /\b(false\s*eyelashes?|press[-\s]?on\s*nails?|nail\s*polish|gel\s*nail\s*strips?|fake\s*nails?|nail\s*stickers?|nail\s*art\s*kit|nail\s*set|toe\s*nail\s*set|acrylic\s*nails?|lash(es)?\s*(glue|kit))\b/i,
    section: 'Lashes & Nails', conf: 0.95, label: 'kw:lashes_nails' },

  // Body care
  { pattern: /\b(body\s*lotion|body\s*cream|body\s*scrub|body\s*wash|body\s*oil|body\s*mist|hand\s*cream|foot\s*cream|deodorant|peeling\s*pad|peeling\s*oil|hammam\s*glove|body\s*brush|body\s*tanning|body\s*peeling|brazilian\s*collagen|hammam)\b/i,
    section: 'Body Care', conf: 0.92, label: 'kw:body' },
  { pattern: /\b(soap|bar\s*soap|whitening\s*soap|charcoal\s*soap)\b/i,
    section: 'Body Care', conf: 0.85, label: 'kw:soap' },

  // Electronics
  { pattern: /\b(charger|adapter|cable|usb-?c|usb[-\s]?type[-\s]?c|power\s*bank|earbuds|earphones|headphones|drone|speaker|bluetooth|wireless\s*(buds|earbuds|earphones)|phone\s*stand|laptop\s*stand|cooling\s*stand|charging\s*dock|tablet\s*stand|monitor)\b/i,
    section: 'Electronics', conf: 0.93, label: 'kw:electronics' },
  { pattern: /\b(heatz|green\s*lion|anker|baseus)\b/i,
    section: 'Electronics', conf: 0.93, label: 'brand:electronics' },

  // Summer & Camping
  { pattern: /\b(inflatable\s*(pool|float|chair|lounge|kids\s*pool)|pool\s*float|beach\s*float|camping\s*(tent|chair|cooler|kit)|flamingo\s*float|splash\s*play\s*mat|camping\s*supplies)\b/i,
    section: 'Summer And Camping Supplies', conf: 0.93, label: 'kw:summer' },

  // Toys
  { pattern: /\b(toy|plush|teddy|action\s*figure|kids\s*game|stuffed\s*animal|puzzle|building\s*block)\b/i,
    section: 'Toys', conf: 0.9, label: 'kw:toy' },

  // Perfumes / Women's Essentials
  { pattern: /\b(eau\s+de\s+parfum|eau\s+de\s+toilette|perfume|fragrance|edt\b|edp\b)\b/i,
    section: "Women's Essentials", conf: 0.85, label: 'kw:perfume' },
  { pattern: /\bwomen'?s?\s*(watch|jewelry|accessories|bag|essentials)\b/i,
    section: "Women's Essentials", conf: 0.88, label: 'kw:women_accessory' },

  // Thailand Products
  { pattern: /\b(frozen\s*(detox|collagen|whitening)|max\s*curve|cathy\s*doll|rosmar|you\s*glow|dear\s*face\s*beauty\s*milk|k[-\s]?drinks|sip\s*n['']?\s*go|arbutin\s*3c3)\b/i,
    section: 'Thailand Products', conf: 0.92, label: 'kw:thai_brand' },
  { pattern: /\bthailand|thai\b/i, section: 'Thailand Products', conf: 0.82, label: 'kw:thai_country' },

  // ─── Phase 13F.18 patch — card holders, tumblers, swim, hair-remover, mirror, bags ──

  // 1. Card holders / wallets (luxury) → Women's Essentials
  { pattern: /\b(card\s*holder|wallet|coin\s*purse|leather\s*card|luxury\s*card)\b/i,
    section: "Women's Essentials", conf: 0.88, label: 'kw:card_holder' },
  // Luxury brand card-holder products (Gucci/YSL/Chanel etc) usually surface only in card/wallet context
  { pattern: /\b(gucci|yves\s*saint\s*laurent|ysl|chanel|prada|dior\s*(?:wallet|card|holder))\b.*\b(card|wallet|purse|holder)\b/i,
    section: "Women's Essentials", conf: 0.9, label: 'kw:luxury_card_brand' },

  // 2. Tumblers / cups / bottles / Stanley → Summer And Camping Supplies
  { pattern: /\b(tumbler|insulated\s*(tumbler|bottle|cup)|stanley\s*(insulated|tumbler|cup)|glass\s*tumbler|water\s*bottle|reusable\s*(bottle|cup)|hot\s*and\s*cold\s*(bottle|cup))\b/i,
    section: 'Summer And Camping Supplies', conf: 0.86, label: 'kw:tumbler' },
  // "straw" alone is too generic — only count when paired with cup/bottle/tumbler context
  { pattern: /\b(?:cup|bottle|mug).{0,30}straw|straw.{0,30}(?:cup|bottle|mug)\b/i,
    section: 'Summer And Camping Supplies', conf: 0.82, label: 'kw:cup_with_straw' },

  // 3. Swimming accessories → Summer And Camping Supplies
  { pattern: /\b(swim\s*cap|swimming\s*(cap|goggles|gear|equipment|accessories)|goggles?|anti[-\s]?fog\s*(lens|goggles)|waterproof\s*swim)\b/i,
    section: 'Summer And Camping Supplies', conf: 0.86, label: 'kw:swimming' },

  // 4. Hair removal devices → Women's Essentials
  { pattern: /\b(hair\s*remover|electric\s*hair\s*remover|rechargeable\s*hair\s*remover|epilator|body\s*hair\s*remover|facial\s*hair\s*remover|painless\s*hair\s*removal)\b/i,
    section: "Women's Essentials", conf: 0.86, label: 'kw:hair_removal' },

  // 5. Mirrors / makeup mirrors / eyelash mirrors → Beauty Accessories
  { pattern: /\b(check\s*mirror|eyelash\s*extension\s*mirror|makeup\s*mirror|vanity\s*mirror|led\s*mirror|compact\s*mirror|handheld\s*mirror)\b/i,
    section: 'Beauty Accessories', conf: 0.86, label: 'kw:mirror' },

  // 6. Bags / organizer / travel pouch / cosmetic bag → Women's Essentials
  // Use cosmetic/travel/makeup/organizer qualifier to avoid catching "tea bag" etc.
  { pattern: /\b(travel\s*(bag|pouch|organizer|case)|cosmetic\s*(bag|pouch|case|organizer)|makeup\s*(bag|pouch|case|organizer)|toiletry\s*bag|organizer\s*bag|jewellery\s*(bag|pouch|organizer)|jewelry\s*(bag|pouch|organizer))\b/i,
    section: "Women's Essentials", conf: 0.87, label: 'kw:bag_organizer' },
];

// ─── Medium keyword rules (confidence 0.75–0.85) ──────────────────────────

const MEDIUM_RULES: KeywordRule[] = [
  // Face care — skincare actives
  { pattern: /\b(retinol|niacinamide|hyaluronic\s*acid|vitamin\s*c|salicylic\s*acid|glycolic|peptide|ceramide|tranexamic|alpha\s*arbutin|kojic)\b/i,
    section: 'Face Care', conf: 0.82, label: 'kw:active_ingredient' },
  // Face care — generic
  { pattern: /\b(serum|cleanser|toner|moisturizer|moisturiser|eye\s*cream|ampoule|essence|face\s*cream|night\s*cream|day\s*cream|exfoliator|peeling\s*gel|brightening\s*cream|anti[-\s]?wrinkle|anti[-\s]?aging|dark\s*spot|melasma|blemish)\b/i,
    section: 'Face Care', conf: 0.78, label: 'kw:face_care_generic' },
  { pattern: /\b(anua|cosrx|beauty\s*of\s*joseon|skin1004|axis[-\s]?y|round\s*lab|haruharu|numbuzin|torriden|some\s*by\s*mi|isntree|pyunkang\s*yul|medicube|biodance|mixsoon|celimax|tocobo|k[-\s]?secret|biodance|goodal|the\s*ordinary|acure|acm)\b/i,
    section: 'Face Care', conf: 0.85, label: 'brand:korean_skincare' },

  // Beauty Accessories — tools
  { pattern: /\b(makeup\s*sponge|beauty\s*blender|beautyblender|face\s*roller|gua\s*sha|jade\s*roller|derma\s*roller|microneedling|dermaplaning|eyebrow\s*razor|tweezers|hair\s*clips?|headband|wrist\s*towel|massage\s*stick|silicone\s*brush|cleansing\s*brush|facial\s*massager|microneedle|cupping\s*device)\b/i,
    section: 'Beauty Accessories', conf: 0.85, label: 'kw:beauty_tool' },
  { pattern: /\b(brush\s*set|makeup\s*brush|fan\s*brush|sponge|puff)\b/i,
    section: 'Beauty Accessories', conf: 0.78, label: 'kw:brush_sponge' },

  // Beauty Bundle (sets) — only when SET/BUNDLE keyword AND not other strong cat
  { pattern: /\b(skincare\s*set|gift\s*set|bundle|combo\s*pack|beauty\s*set|skin\s*care\s*set|kit\s*(?:\(|$|\s)|complete\s*(?:skincare|care)\s*set)\b/i,
    section: 'Beauty Bundle', conf: 0.78, label: 'kw:bundle_generic' },

  // Beard products → Hair Care (closest match in Snoonu's sections)
  { pattern: /\bbeard\s*(?:filler|pencil|colouring|colour|color|pen|comb)\b/i,
    section: 'Hair Care', conf: 0.8, label: 'kw:beard_grooming' },
];

// ─── Generic catch-all rules (confidence 0.6–0.7) ─────────────────────────

const WEAK_RULES: KeywordRule[] = [
  { pattern: /\b(tattoo|temporary\s*tattoo|stencil)\b/i, section: 'Beauty Accessories', conf: 0.7, label: 'kw:tattoo' },
  { pattern: /\b(travel\s*bag|organizer\s*bag|cosmetic\s*bag|makeup\s*pouch|toiletry\s*bag)\b/i, section: 'Beauty Accessories', conf: 0.7, label: 'kw:cosmetic_bag' },
  { pattern: /\b(gift)\b/i, section: 'Gifts & Special Occasions', conf: 0.65, label: 'kw:gift_only' },
];

// ─── Inferrer ──────────────────────────────────────────────────────────────

function buildBlob(input: InferrerInput): string {
  return [
    input.name_en,
    input.name_ar,
    input.description_en,
    input.description_ar,
    input.brand,
  ].filter(Boolean).join(' ');
}

export function inferCategory(input: InferrerInput): InferrerHit | null {
  const blob = buildBlob(input);
  if (!blob.trim()) return null;

  // ─── Pass 1: brand override ─────────────────────────────────────────────
  for (const rule of BRAND_RULES) {
    if (rule.brand.test(blob)) {
      return {
        section: rule.section,
        confidence: rule.conf,
        signals: [rule.label],
        rationale: `Brand match: ${rule.label}`,
      };
    }
  }

  // ─── Pass 2: strong keyword rules — first match wins ────────────────────
  // But collect all hits to detect agreement → boost confidence.
  const allHits: Array<{ rule: KeywordRule; tier: 'strong' | 'medium' | 'weak' }> = [];
  for (const rule of STRONG_RULES) {
    if (rule.pattern.test(blob)) allHits.push({ rule, tier: 'strong' });
  }
  for (const rule of MEDIUM_RULES) {
    if (rule.pattern.test(blob)) allHits.push({ rule, tier: 'medium' });
  }
  for (const rule of WEAK_RULES) {
    if (rule.pattern.test(blob)) allHits.push({ rule, tier: 'weak' });
  }

  if (allHits.length === 0) return null;

  // Score each section: sum of confidences from rules that fire for it
  const scores = new Map<SnoonuSection, { sum: number; rules: KeywordRule[] }>();
  for (const h of allHits) {
    const cur = scores.get(h.rule.section) ?? { sum: 0, rules: [] };
    cur.sum += h.rule.conf;
    cur.rules.push(h.rule);
    scores.set(h.rule.section, cur);
  }

  // Pick the section with the highest summed score
  let best: { section: SnoonuSection; sum: number; rules: KeywordRule[] } | null = null;
  for (const [section, data] of scores) {
    if (!best || data.sum > best.sum) best = { section, ...data };
  }
  if (!best) return null;

  // ─── Compute final confidence ──────────────────────────────────────────
  // Take the highest single rule confidence for the chosen section,
  // boost by +0.05 if there's >1 agreeing rule.
  const topConf = Math.max(...best.rules.map((r) => r.conf));
  let confidence = topConf;
  if (best.rules.length > 1) confidence = Math.min(1.0, topConf + 0.05);

  // ─── Tie-break overrides ───────────────────────────────────────────────
  // If multiple sections tied, prefer the more specific one:
  // Lashes & Nails > Sun Protection > Masks > Dental > Hair Care > Body > Makeup > Face > Beauty Bundle > Electronics > Beauty Accessories > Women's > Gifts > Toys > Eid > Summer > Thai > Rhode > Labubu
  const SPECIFICITY_RANK: Record<SnoonuSection, number> = {
    'Rhode Products Section': 1,
    'Labubu Collection': 2,
    'Lashes & Nails': 3,
    'Sun Protection': 4,
    'Masks': 5,
    'Dental Care': 6,
    'Hair Care': 7,
    'Body Care': 8,
    'Makeup': 9,
    'Face Care': 10,
    'Beauty Bundle': 11,
    'Electronics': 12,
    'Beauty Accessories': 13,
    "Women's Essentials": 14,
    'Gifts & Special Occasions': 15,
    'Toys': 16,
    'Eid Specials': 17,
    'Summer And Camping Supplies': 18,
    'Thailand Products': 19,
  };
  // Re-pick if tie exists
  const tied = [...scores.entries()].filter(([, v]) => v.sum === best!.sum);
  if (tied.length > 1) {
    tied.sort((a, b) => SPECIFICITY_RANK[a[0]] - SPECIFICITY_RANK[b[0]]);
    best = { section: tied[0][0], sum: tied[0][1].sum, rules: tied[0][1].rules };
    confidence = Math.max(...best.rules.map((r) => r.conf));
    if (best.rules.length > 1) confidence = Math.min(1.0, confidence + 0.05);
  }

  // ─── Special rules from spec ───────────────────────────────────────────
  // 6. Rhode → enforced
  if (/\brhode\b/i.test(blob) && best.section !== 'Rhode Products Section') {
    return { section: 'Rhode Products Section', confidence: 1.0, signals: ['enforced:rhode'], rationale: 'Rhode brand override' };
  }
  // 7. Labubu → enforced
  if (/\blabubu\b|\bla\s*bobo\b/i.test(blob) && best.section !== 'Labubu Collection') {
    return { section: 'Labubu Collection', confidence: 1.0, signals: ['enforced:labubu'], rationale: 'Labubu brand override' };
  }

  return {
    section: best.section,
    confidence: Number(confidence.toFixed(2)),
    signals: best.rules.map((r) => r.label),
    rationale: best.rules.length > 1
      ? `${best.rules.length} rules agree on ${best.section}`
      : `Matched ${best.rules[0].label}`,
  };
}
