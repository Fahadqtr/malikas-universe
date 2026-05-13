/**
 * CATEGORIES SERVICE
 * ─────────────────────────────────────────────────────────
 * Manage subcategories + keyword rules + brand rules.
 * Main categories are LOCKED — only read access.
 */
import { z } from 'zod';
import { BaseService, ServiceError } from './base.service';

export class CategoriesService extends BaseService {
  /**
   * All 11 main categories.
   */
  async listMain() {
    const { data, error } = await this.db
      .from('categories')
      .select('*')
      .order('display_order');
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  /**
   * Subcategories for one main category.
   */
  async listSub(category_id: number) {
    const { data, error } = await this.db
      .from('subcategories')
      .select('*')
      .eq('category_id', category_id)
      .order('display_order');
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  async createSub(input: { category_id: number; name: string; name_ar?: string }) {
    this.requireRole(['owner']);
    const schema = z.object({
      category_id: z.number().int(),
      name: z.string().min(2),
      name_ar: z.string().optional(),
    });
    const parsed = schema.parse(input);
    const { data, error } = await this.db.from('subcategories').insert(parsed).select('*').single();
    if (error) throw new ServiceError('CREATE_FAILED', error.message, 500);
    return data;
  }

  async updateSub(id: number, input: { name?: string; name_ar?: string; is_active?: boolean }) {
    this.requireRole(['owner']);
    const { data, error } = await this.db
      .from('subcategories')
      .update(input)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('UPDATE_FAILED', error.message, 500);
    return data;
  }

  async deleteSub(id: number) {
    this.requireRole(['owner']);

    // Block if any products use this subcategory
    const { count } = await this.db
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('subcategory_id', id);
    if ((count ?? 0) > 0) {
      throw new ServiceError(
        'IN_USE',
        `Cannot delete: ${count} products use this subcategory`,
        409,
      );
    }

    const { error } = await this.db.from('subcategories').delete().eq('id', id);
    if (error) throw new ServiceError('DELETE_FAILED', error.message, 500);
    return { deleted: true };
  }

  /**
   * Keyword rules — used by Category Engine.
   */
  async listKeywords(category_id?: number) {
    let q = this.db.from('keyword_rules').select('*').order('keyword');
    if (category_id) q = q.eq('category_id', category_id);
    const { data, error } = await q;
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  async addKeyword(input: {
    keyword: string;
    language: 'en' | 'ar';
    category_id: number;
    subcategory_id?: number | null;
  }) {
    this.requireRole(['owner']);
    const { data, error } = await this.db
      .from('keyword_rules')
      .insert({ ...input, confidence: 0.95 })
      .select('*')
      .single();
    if (error) throw new ServiceError('CREATE_FAILED', error.message, 500);
    return data;
  }

  async removeKeyword(id: number) {
    this.requireRole(['owner']);
    const { error } = await this.db.from('keyword_rules').delete().eq('id', id);
    if (error) throw new ServiceError('DELETE_FAILED', error.message, 500);
    return { deleted: true };
  }

  /**
   * Brand rules.
   */
  async listBrandRules() {
    const { data, error } = await this.db
      .from('category_rules')
      .select('id, brand_id, category_id, default_subcategory_id, brand:brands(name)');
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  async upsertBrandRule(input: {
    brand_id: number;
    category_id: number;
    default_subcategory_id?: number | null;
  }) {
    this.requireRole(['owner']);
    const { data, error } = await this.db
      .from('category_rules')
      .upsert(input, { onConflict: 'brand_id' })
      .select('*')
      .single();
    if (error) throw new ServiceError('UPSERT_FAILED', error.message, 500);
    return data;
  }
}
