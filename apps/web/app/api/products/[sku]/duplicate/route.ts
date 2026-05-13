import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const POST = withErrorHandling(
  async (_req: NextRequest, ctx: { params: { sku: string } }) => {
    const actor = await getActor();
    const { products } = getServices(actor);
    const copy = await products.duplicate(ctx.params.sku);
    return ok(copy, 201);
  },
);
