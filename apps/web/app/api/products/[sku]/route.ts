import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

type Ctx = { params: { sku: string } };

export const GET = withErrorHandling(async (_req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { products } = getServices(actor);
  const data = await products.findBySku(ctx.params.sku);
  return ok(data);
});

export const PUT = withErrorHandling(async (req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { products } = getServices(actor);
  const body = await req.json();
  const updated = await products.update(ctx.params.sku, body);
  return ok(updated);
});

export const DELETE = withErrorHandling(async (_req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { products } = getServices(actor);
  const result = await products.softDelete(ctx.params.sku);
  return ok(result);
});
