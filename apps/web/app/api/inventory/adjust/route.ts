import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { inventory } = getServices(actor);
  const body = await req.json();
  return ok(await inventory.adjust(body));
});
