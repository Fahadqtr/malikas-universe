/**
 * SEARCH SERVICE
 * ─────────────────────────────────────────────────────────
 * Wraps the DB search_products() RPC into a clean TS API.
 * The RPC handles tier escalation (exact → fuzzy → semantic).
 */
import { z } from 'zod';
import { BaseService, ServiceError } from './base.service';

export const searchInputSchema = z.object({
  q: z.string().trim().min(1),
  embedding: z.array(z.number()).length(1536).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

export type SearchHit = {
  master_sku: string;
  product_name_en: string;
  product_name_ar: string;
  price: number;
  stock_quantity: number;
  image_url: string | null;
  score: number;
  tier: string;
};

export class SearchService extends BaseService {
  /**
   * Hybrid search via single DB RPC.
   * AI agent + admin search both call this.
   */
  async search(input: z.infer<typeof searchInputSchema>): Promise<SearchHit[]> {
    const parsed = searchInputSchema.parse(input);

    const { data, error } = await this.db.rpc('search_products', {
      p_query: parsed.q,
      p_embedding: (parsed.embedding ?? null) as never,
      p_limit: parsed.limit,
    } as never);

    if (error) throw new ServiceError('SEARCH_FAILED', error.message, 500);
    return (data as SearchHit[]) ?? [];
  }

  /**
   * Find potential duplicates of a specific SKU.
   */
  async findDuplicates(master_sku: string, threshold = 0.7) {
    const { data, error } = await this.db.rpc('find_duplicate_candidates', {
      p_master_sku: master_sku,
      p_threshold: threshold,
    } as never);
    if (error) throw new ServiceError('DUPE_SEARCH_FAILED', error.message, 500);
    return data ?? [];
  }
}
