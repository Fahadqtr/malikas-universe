import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { inventory } = getServices(actor);
  const threshold = Number(req.nextUrl.searchParams.get('threshold') ?? 5);
  return ok(await inventory.lowStock(threshold));
});
