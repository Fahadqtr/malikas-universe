import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

const BulkRequest = z.object({
  action: z.enum(['update', 'soft_delete']),
  master_skus: z.array(z.string()).min(1).max(500),
  update: z.record(z.unknown()).optional(),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { products } = getServices(actor);
  const body = BulkRequest.parse(await req.json());

  if (body.action === 'update') {
    if (!body.update) return err('NO_UPDATE_PAYLOAD', 'update body required', 400);
    return ok(await products.bulkUpdate(body.master_skus, body.update as never));
  }
  return ok(await products.bulkSoftDelete(body.master_skus));
});
