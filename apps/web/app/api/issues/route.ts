import { NextRequest } from 'next/server';
import { ok, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';

export const GET = withErrorHandling(async (req: NextRequest) => {
  const actor = await getActor();
  const { issues } = getServices(actor);
  const sev = req.nextUrl.searchParams.get('severity') as
    | 'critical' | 'high' | 'medium' | 'low' | null;
  return ok({
    summary: await issues.summary(),
    items: await issues.listOpen({ severity: sev ?? undefined }),
  });
});
