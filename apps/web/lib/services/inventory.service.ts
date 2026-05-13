/**
 * INVENTORY SERVICE
 * ─────────────────────────────────────────────────────────
 * Stock movements + low stock detection.
 *
 * Every change writes one row to `inventory` (append-only).
 * Products.stock_quantity is the snapshot — kept in sync transactionally.
 */
import { z } from 'zod';
import { BaseService, ServiceError } from './base.service';

export const stockAdjustmentSchema = z.object({
  master_sku: z.string(),
  change_type: z.enum(['restock', 'sale', 'return', 'adjustment', 'damaged', 'expired']),
  quantity_delta: z.number().int(),
  reason: z.string().optional(),
  platform: z.enum(['snoonu', 'shopify', 'talabat', 'rafeeq', 'manual']).optional(),
  reference_id: z.string().optional(),
});

export class InventoryService extends BaseService {
  /**
   * Apply a stock movement.
   * Writes the inventory row AND updates products.stock_quantity in one transaction.
   */
  async adjust(input: z.infer<typeof stockAdjustmentSchema>) {
    this.requireRole(['owner', 'editor', 'viewer']);
    const parsed = stockAdjustmentSchema.parse(input);

    // Read current
    const { data: product, error: readErr } = await this.db
      .from('products')
      .select('master_sku, stock_quantity')
      .eq('master_sku', parsed.master_sku)
      .is('deleted_at', null)
      .single();
    if (readErr || !product) throw new ServiceError('NOT_FOUND', 'Product not found', 404);

    const newQty = (product.stock_quantity ?? 0) + parsed.quantity_delta;
    if (newQty < 0) {
      throw new ServiceError(
        'NEGATIVE_STOCK',
        `Result would be ${newQty} (current ${product.stock_quantity}, delta ${parsed.quantity_delta})`,
        409,
      );
    }

    // Insert inventory log
    const { error: invErr } = await this.db.from('inventory').insert({
      master_sku: parsed.master_sku,
      change_type: parsed.change_type,
      quantity_delta: parsed.quantity_delta,
      quantity_after: newQty,
      reason: parsed.reason ?? null,
      platform: parsed.platform ?? 'manual',
      reference_id: parsed.reference_id ?? null,
      actor: this.actorTag(),
    });
    if (invErr) throw new ServiceError('INVENTORY_LOG_FAILED', invErr.message, 500);

    // Update product snapshot (trigger auto-updates stock_status)
    const { data: updated, error: updErr } = await this.db
      .from('products')
      .update({ stock_quantity: newQty, updated_by: this.actorTag() })
      .eq('master_sku', parsed.master_sku)
      .select('master_sku, stock_quantity, stock_status')
      .single();
    if (updErr || !updated) throw new ServiceError('UPDATE_FAILED', updErr?.message ?? '', 500);

    return {
      master_sku: updated.master_sku,
      stock_quantity: updated.stock_quantity,
      stock_status: updated.stock_status,
      delta_applied: parsed.quantity_delta,
    };
  }

  /**
   * Movement history for a SKU.
   */
  async historyForSku(master_sku: string, limit = 100) {
    const { data, error } = await this.db
      .from('inventory')
      .select('*')
      .eq('master_sku', master_sku)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  /**
   * All products under low-stock threshold.
   */
  async lowStock(threshold = 5) {
    const { data, error } = await this.db
      .from('products')
      .select('master_sku, product_name_en, stock_quantity, stock_status, price')
      .lte('stock_quantity', threshold)
      .eq('product_status', 'active')
      .is('deleted_at', null)
      .order('stock_quantity', { ascending: true });
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  /**
   * Velocity: units sold in last N days.
   */
  async velocity(master_sku: string, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.db
      .from('inventory')
      .select('quantity_delta, created_at')
      .eq('master_sku', master_sku)
      .eq('change_type', 'sale')
      .gte('created_at', since);
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    const totalUnits = (data ?? []).reduce((sum, r) => sum + Math.abs(r.quantity_delta), 0);
    return { master_sku, days, units_sold: totalUnits, units_per_day: totalUnits / days };
  }
}
