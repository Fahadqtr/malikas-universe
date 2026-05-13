/**
 * GET /api/export/[platform]?status=active
 *
 * Downloads a platform-shaped CSV of products.
 * Platforms: snoonu, shopify, talabat, rafeeq, master
 */
import { NextRequest } from 'next/server';
import { getActor } from '@/lib/actor';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { EXPORTERS, type PlatformExport, type ExportRow } from '@/lib/exporters';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(req: NextRequest, ctx: { params: { platform: string } }) {
  try {
    const actor = await getActor();
    if (!['owner', 'editor'].includes(actor.role)) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    const platform = ctx.params.platform as PlatformExport;
    const exporter = EXPORTERS[platform];
    if (!exporter) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'UNKNOWN_PLATFORM' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    const statusFilter = req.nextUrl.searchParams.get('status') ?? 'active';

    const admin = createAdminSupabaseClient();
    let query = admin
      .from('products')
      .select(
        `master_sku, snoonu_sku, barcode, product_name_en, product_name_ar,
         product_type, size, price, discount_price, stock_quantity, stock_status, product_status,
         description_en, description_ar, usage_en, usage_ar,
         keywords_en, keywords_ar, image_url,
         brand:brands(name),
         category:categories(name),
         subcategory:subcategories(name)`,
      )
      .is('deleted_at', null)
      .order('master_sku');

    if (statusFilter !== 'all') {
      query = query.eq('product_status', statusFilter);
    }

    const { data, error } = await query;
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'DB_ERROR', message: error.message } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    const rows: ExportRow[] = (data ?? []).map((r) => {
      const brand = r.brand as unknown as { name: string } | null;
      const cat = r.category as unknown as { name: string } | null;
      const sub = r.subcategory as unknown as { name: string } | null;
      return {
        master_sku: r.master_sku,
        snoonu_sku: r.snoonu_sku,
        barcode: r.barcode,
        product_name_en: r.product_name_en,
        product_name_ar: r.product_name_ar,
        brand_name: brand?.name ?? '',
        category_name: cat?.name ?? '',
        subcategory_name: sub?.name ?? null,
        product_type: r.product_type,
        size: r.size,
        price: Number(r.price),
        discount_price: r.discount_price != null ? Number(r.discount_price) : null,
        stock_quantity: r.stock_quantity ?? 0,
        stock_status: r.stock_status,
        product_status: r.product_status,
        description_en: r.description_en,
        description_ar: r.description_ar,
        usage_en: r.usage_en,
        usage_ar: r.usage_ar,
        keywords_en: r.keywords_en,
        keywords_ar: r.keywords_ar,
        image_url: r.image_url,
      };
    });

    const csv = exporter(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${platform}-${stamp}-${rows.length}rows.csv`;

    return new Response('﻿' + csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown';
    return new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: msg } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
