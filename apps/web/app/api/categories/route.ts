import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const GET = withErrorHandling(async (_req: NextRequest) => {
  const actor = await getActor();
  const { categories } = getServices(actor);
  return ok(await categories.listMain());
});
