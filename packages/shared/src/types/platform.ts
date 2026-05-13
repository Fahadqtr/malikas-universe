import { z } from 'zod';

export const PLATFORMS = ['snoonu', 'shopify', 'talabat', 'rafeeq', 'website'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_STATUSES = ['active', 'draft', 'not_listed', 'out_of_stock', 'rejected'] as const;
export type PlatformStatus = (typeof PLATFORM_STATUSES)[number];

export const platformMappingSchema = z.object({
  master_sku: z.string(),
  platform: z.enum(PLATFORMS),
  platform_product_id: z.string().optional().nullable(),
  platform_sku: z.string().optional().nullable(),
  platform_price: z.number().nonnegative().optional().nullable(),
  platform_status: z.enum(PLATFORM_STATUSES).optional().nullable(),
  platform_url: z.string().url().optional().nullable(),
});

export type PlatformMapping = z.infer<typeof platformMappingSchema>;
