import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { search } = getServices(actor);
  const body = await req.json();
  return ok(await search.search(body));
});
