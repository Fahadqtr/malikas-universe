import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const GET = withErrorHandling(
  async (_req: NextRequest, ctx: { params: { sku: string } }) => {
    const actor = await getActor();
    const { products } = getServices(actor);
    return ok(await products.history(ctx.params.sku));
  },
);
