/**
 * CLEANING ENGINE — normalizes raw rows into a canonical shape.
 * Pure functions. No I/O. No DB.
 */
import { stripDiacritics } from '../utils/arabic';

const MARKETING_NOISE = [
  'new', 'trending', 'k-beauty', 'k beauty', 'best seller', 'bestseller',
  'viral', 'tiktok', 'hot', 'sale', 'limited', 'exclusive', '✨', '🔥', '⭐',
];

export function cleanProductName(raw: string): string {
  if (!raw) return '';
  let s = raw.trim().replace(/\s+/g, ' ');
  s = s.replace(/^[^\w؀-ۿ]+|[^\w؀-ۿ.()]+$/gu, '').trim();
  s = s.replace(/\b[A-Z]{5,}\b/g, (m) => m[0]! + m.slice(1).toLowerCase());
  return s;
}

export function cleanArabicName(raw: string): string {
  if (!raw) return '';
  return stripDiacritics(raw).trim().replace(/\s+/g, ' ');
}

export function normalizeBrand(raw: string): string {
  if (!raw) return '';
  return raw.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '');
}

export function extractSize(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  const m = s.match(
    /(\d+(?:\.\d+)?)\s*(ml|millilitre|milliliter|l|liter|litre|g|gram|kg|oz|pcs|pieces?|count|ct|pack|patches|pads|sheets?|capsules?|tablets?)/,
  );
  if (!m) return null;
  const value = m[1];
  let unit = m[2];
  const unitMap: Record<string, string> = {
    millilitre: 'ml', milliliter: 'ml', liter: 'l', litre: 'l', gram: 'g',
    piece: 'pcs', pieces: 'pcs', count: 'pcs', ct: 'pcs',
    patches: 'pcs', pads: 'pcs', sheet: 'sheets',
    capsule: 'pcs', capsules: 'pcs', tablet: 'pcs', tablets: 'pcs',
  };
  unit = unitMap[unit] ?? unit;
  return `${value}${unit}`;
}

export function parsePrice(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  const s = String(raw)
    .replace(/[^\d.,-]/g, '')
    .replace(/,(?=\d{3}\b)/g, '')
    .replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : null;
}

export function parseStock(raw: string | number | null | undefined): number {
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function parseBarcode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 || digits.length === 13 || digits.length === 14) return digits;
  return null;
}

export function imageFilenameFor(masterSku: string, ext: 'jpg' | 'webp' | 'png' = 'jpg'): string {
  return `${masterSku.toLowerCase()}.${ext}`;
}

export function stripMarketingNoise(s: string): string {
  let out = s.toLowerCase();
  for (const word of MARKETING_NOISE) {
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function normalizeForMatching(name: string): string {
  const stripped = stripDiacritics(name.toLowerCase());
  const clean = stripMarketingNoise(stripped);
  const tokens = clean.split(/\s+/).filter(Boolean).sort();
  return tokens.join(' ');
}

export type CleanedRow = {
  raw_index: number;
  snoonu_sku: string | null;
  barcode: string | null;
  product_name_en: string;
  product_name_ar: string;
  brand_raw: string;
  size: string | null;
  variant: string | null;
  color: string | null;
  price: number | null;
  discount_price: number | null;
  cost: number | null;
  stock_quantity: number;
  description_en: string | null;
  description_ar: string | null;
  image_url: string | null;
  category_hint: string | null;
  source_platform: 'snoonu' | 'shopify' | 'talabat' | 'rafeeq' | 'import';
};

export type FieldMapping = {
  snoonu_sku?: string;
  barcode?: string;
  product_name_en?: string;
  product_name_ar?: string;
  brand?: string;
  size?: string;
  variant?: string;
  color?: string;
  price?: string;
  discount_price?: string;
  cost?: string;
  stock?: string;
  description_en?: string;
  description_ar?: string;
  image_url?: string;
  category_hint?: string;
};

export function cleanRow(
  raw: Record<string, unknown>,
  mapping: FieldMapping,
  index: number,
  source_platform: CleanedRow['source_platform'] = 'import',
): CleanedRow {
  const get = (key?: string): string => {
    if (!key) return '';
    const v = raw[key];
    return v == null ? '' : String(v);
  };

  const nameEn = cleanProductName(get(mapping.product_name_en));
  const nameAr = cleanArabicName(get(mapping.product_name_ar));
  const explicitSize = get(mapping.size);
  const size = explicitSize ? extractSize(explicitSize) : extractSize(nameEn);

  return {
    raw_index: index,
    snoonu_sku: get(mapping.snoonu_sku) || null,
    barcode: parseBarcode(get(mapping.barcode)),
    product_name_en: nameEn,
    product_name_ar: nameAr,
    brand_raw: normalizeBrand(get(mapping.brand)),
    size,
    variant: get(mapping.variant) || null,
    color: get(mapping.color) || null,
    price: parsePrice(get(mapping.price)),
    discount_price: parsePrice(get(mapping.discount_price)),
    cost: parsePrice(get(mapping.cost)),
    stock_quantity: parseStock(get(mapping.stock)),
    description_en: get(mapping.description_en) || null,
    description_ar: get(mapping.description_ar) || null,
    image_url: get(mapping.image_url) || null,
    category_hint: get(mapping.category_hint) || null,
    source_platform,
  };
}
