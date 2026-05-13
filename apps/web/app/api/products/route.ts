import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

/**
 * GET /api/products — paginated list
 * Query params: page, page_size, brand_id, category_id, status, stock_status, q, sort, include_deleted
 */
export const GET = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { products } = getServices(actor);
  const params = req.nextUrl.searchParams;

  const list = await products.list({
    page: Number(params.get('page') ?? 1),
    page_size: Number(params.get('page_size') ?? 50),
    brand_id: params.get('brand_id') ? Number(params.get('brand_id')) : undefined,
    category_id: params.get('category_id') ? Number(params.get('category_id')) : undefined,
    status: (params.get('status') as never) ?? undefined,
    stock_status: (params.get('stock_status') as never) ?? undefined,
    q: params.get('q') ?? undefined,
    source_platform: params.get('source_platform') ?? undefined,
    include_deleted: params.get('include_deleted') === 'true',
    sort: (params.get('sort') as never) ?? 'updated_at_desc',
  });

  return ok(list);
});

/**
 * POST /api/products — create
 */
export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { products } = getServices(actor);
  const body = await req.json();
  const created = await products.create(body);
  return ok(created, 201);
});
