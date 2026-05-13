import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

type Ctx = { params: { id: string } };

export const DELETE = withErrorHandling(async (_req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { images } = getServices(actor);
  const id = Number(ctx.params.id);
  if (!Number.isFinite(id)) return err('BAD_ID', 'Invalid image id', 400);
  return ok(await images.delete(id));
});

export const PATCH = withErrorHandling(async (_req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { images } = getServices(actor);
  const id = Number(ctx.params.id);
  return ok(await images.setPrimary(id));
});
