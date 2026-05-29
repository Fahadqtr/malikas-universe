/**
 * GET /api/snoonu-browser-audit/queue
 *
 * Returns the prioritized audit queue for /snoonu-browser-audit.
 *
 * Two ways to use it:
 *   ?refresh=true  — first call enqueue_snoonu_audits() to populate pending
 *                    rows from current data, then return the queue.
 *   default        — just return the existing queue.
 *
 * Query params:
 *   ?import_id=    Snoonu import id (default: most recent)
 *   ?status=pending|audited|verified|applied|skipped|error  (default: pending+audited)
 *   ?reason=       filter by audit_reason
 *   ?priority_max= include only rows with audit_priority <= this
 *   ?limit=50      page size
 *   ?page=1
 *
 * Each row includes the joined platform_products row so the UI can render
 * product name, current detected category, current snoonu_category, etc.
 */

import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const GET = withErrorHandling(async (req: NextRequest) => {
  const url = new URL(req.url);

  // Resolve import_id
  const admin = createAdminSupabaseClient();
  let importId = Number(url.searchParams.get('import_id'));
  if (!Number.isInteger(importId) || importId <= 0) {
    const { data } = await admin
      .from('platform_imports')
      .select('id')
      .eq('platform', 'snoonu')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    importId = (data as { id: number } | null)?.id ?? 0;
  }
  if (!importId) {
    return ok({
      rows: [],
      page: 1,
      limit: 50,
      total: 0,
      summary: null,
      message: 'No Snoonu imports found',
    });
  }

  // Optional refresh — re-run the queue builder
  if (url.searchParams.get('refresh') === 'true') {
    await admin.rpc('enqueue_snoonu_audits', { p_import_id: importId, p_limit: 5000 });
  }

  // Filters
  const statusParam = url.searchParams.get('status');
  const reasonParam = url.searchParams.get('reason');
  const priorityMax = url.searchParams.get('priority_max');
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = (page - 1) * limit;

  let q = admin
    .from('snoonu_browser_audits')
    .select(
      `*,
       product:platform_products!product_id (
         id, source_sku, name_en, name_ar, brand, normalized_name, image_url,
         price, stock_quantity, category_name, raw_category,
         snoonu_catalog, snoonu_category, snoonu_subcategory,
         snoonu_section, snoonu_menu_path, catalog_source, catalog_confidence
       )`,
      { count: 'exact' },
    )
    .eq('import_id', importId);

  if (statusParam) {
    // Allow comma list e.g. ?status=pending,audited
    const statuses = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) q = q.in('audit_status', statuses);
  } else {
    q = q.in('audit_status', ['pending', 'audited']);
  }

  if (reasonParam) q = q.eq('audit_reason', reasonParam);
  if (priorityMax) {
    const n = Number(priorityMax);
    if (Number.isFinite(n)) q = q.lte('audit_priority', n);
  }

  q = q
    .order('audit_priority', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await q;
  if (error) return err('QUEUE_QUERY_FAILED', error.message, 500);

  // Progress summary
  const { data: summary } = await admin
    .from('v_snoonu_browser_audit_progress')
    .select('*')
    .eq('import_id', importId)
    .maybeSingle();

  // Breakdown by reason
  const { data: reasonsRaw } = await admin
    .from('snoonu_browser_audits')
    .select('audit_reason, audit_status')
    .eq('import_id', importId);

  const byReason: Record<string, { pending: number; total: number }> = {};
  for (const r of reasonsRaw ?? []) {
    const row = r as { audit_reason: string | null; audit_status: string };
    const key = row.audit_reason ?? 'unspecified';
    if (!byReason[key]) byReason[key] = { pending: 0, total: 0 };
    byReason[key].total++;
    if (row.audit_status === 'pending') byReason[key].pending++;
  }

  return ok({
    rows: data ?? [],
    page,
    limit,
    total: count ?? 0,
    import_id: importId,
    summary: summary ?? null,
    by_reason: byReason,
  });
});
