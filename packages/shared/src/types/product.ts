import { z } from 'zod';

/**
 * 11 LOCKED main categories.
 */
export const MAIN_CATEGORIES = [
  'Korean Skincare',
  'Thai Products',
  'Hair Care',
  'Makeup',
  'Body Care',
  'Perfumes',
  'Beauty Tools',
  'Bags & Accessories',
  'Gifts & Sets',
  'Kids & Toys',
  'Trending Products',
] as const;

export type MainCategory = (typeof MAIN_CATEGORIES)[number];

export const CATEGORY_CODES = {
  'Korean Skincare': 'SKIN',
  'Thai Products': 'THAI',
  'Hair Care': 'HAIR',
  Makeup: 'MAKEUP',
  'Body Care': 'BODY',
  Perfumes: 'PERF',
  'Beauty Tools': 'TOOL',
  'Bags & Accessories': 'BAG',
  'Gifts & Sets': 'GIFT',
  'Kids & Toys': 'KIDS',
  'Trending Products': 'TREND',
} as const satisfies Record<MainCategory, string>;

export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock', 'pre_order', 'discontinued'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const PRODUCT_STATUSES = ['draft', 'pending_approval', 'active', 'archived', 'blocked'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const productSchema = z.object({
  master_sku: z.string().regex(/^MK-[A-Z]+-\d{4}$/),
  detailed_sku: z.string().optional().nullable(),
  snoonu_sku: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  product_name_en: z.string().min(3),
  product_name_ar: z.string().min(3),
  brand_id: z.number().int().positive(),
  category_id: z.number().int().positive(),
  subcategory_id: z.number().int().positive().optional().nullable(),
  product_type: z.string().optional().nullable(),
  variant: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  size: z.string().optional().nullable(),
  price: z.number().nonnegative().max(50000),
  discount_price: z.number().nonnegative().max(50000).optional().nullable(),
  cost: z.number().nonnegative().max(50000).optional().nullable(),
  stock_quantity: z.number().int().nonnegative().default(0),
  stock_status: z.enum(STOCK_STATUSES).default('in_stock'),
  product_status: z.enum(PRODUCT_STATUSES).default('draft'),
  image_url: z.string().url().optional().nullable(),
  image_filename: z.string().optional().nullable(),
  description_en: z.string().optional().nullable(),
  description_ar: z.string().optional().nullable(),
  usage_en: z.string().optional().nullable(),
  usage_ar: z.string().optional().nullable(),
  keywords_en: z.array(z.string()).optional().nullable(),
  keywords_ar: z.array(z.string()).optional().nullable(),
  source_platform: z
    .enum(['snoonu', 'shopify', 'talabat', 'rafeeq', 'manual', 'import'])
    .default('snoonu'),
});

export type Product = z.infer<typeof productSchema>;

export const productCreateSchema = productSchema.omit({ master_sku: true }).extend({
  master_sku: z.string().regex(/^MK-[A-Z]+-\d{4}$/).optional(),
});
export type ProductCreate = z.infer<typeof productCreateSchema>;

export const productUpdateSchema = productSchema.partial();
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
