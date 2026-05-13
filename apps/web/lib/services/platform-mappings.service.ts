/**
 * PLATFORM MAPPINGS SERVICE
 * ─────────────────────────────────────────────────────────
 * Tracks each product's listing on each platform.
 * One row per (master_sku, platform).
 *
 * Sync status: matched_auto | matched_review | missing | mismatch | inactive | rejected
 */
import { z } from 'zod';
import { BaseService, ServiceError } from './base.service';

export const upsertMappingSchema = z.object({
  master_sku: z.string(),
  platform: z.enum(['snoonu', 'shopify', 'talabat', 'rafeeq', 'website']),
  platform_product_id: z.string().optional().nullable(),
  platform_sku: z.string().optional().nullable(),
  platform_price: z.number().nonnegative().optional().nullable(),
  platform_status: z.enum(['active', 'draft', 'not_listed', 'out_of_stock', 'rejected']).optional().nullable(),
  platform_url: z.string().url().optional().nullable(),
});

export class PlatformMappingsService extends BaseService {
  async listForProduct(master_sku: string) {
    const { data, error } = await this.db
      .from('platform_mappings')
      .select('*')
      .eq('master_sku', master_sku);
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  async upsert(input: z.infer<typeof upsertMappingSchema>) {
    this.requireRole(['owner', 'editor']);
    const parsed = upsertMappingSchema.parse(input);

    const { data, error } = await this.db
      .from('platform_mappings')
      .upsert(parsed, { onConflict: 'master_sku,platform' })
      .select('*')
      .single();
    if (error) throw new ServiceError('UPSERT_FAILED', error.message, 500);
    return data;
  }

  async markSynced(master_sku: string, platform: string, success: boolean, error?: string) {
    const { error: dbErr } = await this.db
      .from('platform_mappings')
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_status: success ? 'success' : 'error',
        sync_error: error ?? null,
      })
      .eq('master_sku', master_sku)
      .eq('platform', platform);
    if (dbErr) throw new ServiceError('SYNC_LOG_FAILED', dbErr.message, 500);
  }

  /**
   * Platform gaps view: products missing from a platform.
   */
  async gapsForPlatform(platform: string) {
    const { data, error } = await this.db
      .from('v_platform_gaps' as never)
      .select('*');
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    const key = `on_${platform}` as const;
    return (data as Array<Record<string, unknown>>).filter((r) => !r[key]);
  }

  /**
   * Price mismatches across platforms.
   */
  async priceMismatches() {
    const { data, error } = await this.db.from('v_price_mismatches' as never).select('*');
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }
}
