/**
 * VALIDATION ISSUES SERVICE
 * ─────────────────────────────────────────────────────────
 * Reads + resolves issues raised by Validation Engine.
 * Used by /issues admin page.
 */
import type { Database } from '@malikas/db';
import { BaseService, ServiceError } from './base.service';

type ValidationIssueUpdate = Database['public']['Tables']['validation_issues']['Update'];

export class ValidationIssuesService extends BaseService {
  async listOpen(opts?: { severity?: 'critical' | 'high' | 'medium' | 'low'; limit?: number }) {
    let q = this.db
      .from('validation_issues')
      .select(
        `id, master_sku, rule_id, severity, field_name, message, suggested_fix, created_at,
         product:products(master_sku, product_name_en, image_url, product_status)`,
      )
      .eq('status', 'open');
    if (opts?.severity) q = q.eq('severity', opts.severity);
    q = q.order('severity', { ascending: true }).order('created_at', { ascending: true });
    q = q.limit(opts?.limit ?? 200);

    const { data, error } = await q;
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);
    return data ?? [];
  }

  async resolve(id: number, note?: string) {
    this.requireRole(['owner', 'editor']);
    const update: ValidationIssueUpdate = {
      status: 'resolved',
      resolved_by: this.actorTag(),
      resolved_at: new Date().toISOString(),
    };
    if (note) update.message = note;
    const { error } = await this.db.from('validation_issues').update(update).eq('id', id);
    if (error) throw new ServiceError('UPDATE_FAILED', error.message, 500);
    return { resolved: true };
  }

  async wontFix(id: number, note?: string) {
    this.requireRole(['owner', 'editor']);
    const update: ValidationIssueUpdate = {
      status: 'wont_fix',
      resolved_by: this.actorTag(),
      resolved_at: new Date().toISOString(),
    };
    if (note) update.message = note;
    const { error } = await this.db.from('validation_issues').update(update).eq('id', id);
    if (error) throw new ServiceError('UPDATE_FAILED', error.message, 500);
    return { wont_fix: true };
  }

  async summary() {
    const { data, error } = await this.db
      .from('validation_issues')
      .select('severity')
      .eq('status', 'open');
    if (error) throw new ServiceError('READ_FAILED', error.message, 500);

    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of data ?? []) {
      const s = r.severity as keyof typeof counts;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }
}
