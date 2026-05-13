import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

type Ctx = { params: { sku: string } };

export const GET = withErrorHandling(async (_req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { platforms } = getServices(actor);
  return ok(await platforms.listForProduct(ctx.params.sku));
});

export const POST = withErrorHandling(async (req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { platforms } = getServices(actor);
  const body = await req.json();
  return ok(await platforms.upsert({ ...body, master_sku: ctx.params.sku }));
});
