/**
 * GET    /api/snoonu-browser-audit/[id]
 * PATCH  /api/snoonu-browser-audit/[id]  → skip / verify / re-queue
 *
 * GET returns the audit row + joined product.
 * PATCH accepts:
 *   { action: 'skip' | 'verify' | 'requeue' | 'mark_error', notes?: string }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

type RouteContext = { params: { id: string } };

export const GET = withErrorHandling(async (_req: NextRequest, { params }: RouteContext) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return err('BAD_ID', 'Invalid audit id', 400);

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from('snoonu_browser_audits')
    .select(
      `*,
       product:platform_products!product_id (
         id, source_sku, name_en, name_ar, brand, price, stock_quantity, image_url,
         category_name, snoonu_catalog, snoonu_category, snoonu_menu_path,
         catalog_source, catalog_confidence
       )`,
    )
    .eq('id', id)
    .maybeSingle();

  if (!data) return err('NOT_FOUND', `Audit ${id} not found`, 404);
  return ok({ audit: data });
});

const PatchSchema = z.object({
  action: z.enum(['skip', 'verify', 'requeue', 'mark_error']),
  notes: z.string().max(2000).optional(),
});

export const PATCH = withErrorHandling(async (req: NextRequest, { params }: RouteContext) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return err('BAD_ID', 'Invalid audit id', 400);

  const body = PatchSchema.parse(await req.json());

  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  const admin = createAdminSupabaseClient();
  const now = new Date().toISOString();

  let update: Record<string, unknown> = {};
  switch (body.action) {
    case 'skip':
      update = { audit_status: 'skipped', audit_notes: body.notes ?? null, audited_by: user.id, audited_at: now };
      break;
    case 'verify':
      update = {
        audit_status: 'verified',
        audit_notes: body.notes ?? null,
        verified_at: now,
        verified_by: user.id,
      };
      break;
    case 'requeue':
      update = { audit_status: 'pending', audit_notes: body.notes ?? null };
      break;
    case 'mark_error':
      update = {
        audit_status: 'error',
        audit_error_message: body.notes ?? 'Marked as error by operator',
      };
      break;
  }

  const { error } = await admin.from('snoonu_browser_audits').update(update).eq('id', id);
  if (error) return err('UPDATE_FAILED', error.message, 500);

  return ok({ audit_id: id, new_status: update.audit_status });
});
