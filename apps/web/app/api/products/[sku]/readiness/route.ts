/**
 * GET /api/products/[sku]/readiness?target=shopify|snoonu|talabat|rafeeq
 *
 * Returns the readiness result for a single product against one marketplace.
 *
 * Query params:
 *   target  (required) one of: shopify | snoonu | talabat | rafeeq
 *
 * Response:
 *   {
 *     ok: true,
 *     data: {
 *       target,
 *       ready,
 *       score,           // 0..100
 *       issues: [...],
 *       error_count,
 *       warning_count,
 *     }
 *   }
 *
 * The validator is pure — same input always yields same result. We load the
 * product through the existing ProductsService so RLS + auth still apply.
 */
import { z } from 'zod';
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { getActor } from '@/lib/actor';
import { getServices } from '@/lib/services';
import { checkReadiness, type MarketplaceTarget } from '@/lib/readiness';

export const runtime = 'nodejs';

const TargetSchema = z.enum(['shopify', 'snoonu', 'talabat', 'rafeeq']);

type Ctx = { params: { sku: string } };

export const GET = withErrorHandling(async (req: NextRequest, ctx: Ctx) => {
  const actor = await getActor();
  const { products } = getServices(actor);

  const targetRaw = req.nextUrl.searchParams.get('target');
  const parsed = TargetSchema.safeParse(targetRaw);
  if (!parsed.success) {
    return err(
      'BAD_TARGET',
      `target must be one of: shopify, snoonu, talabat, rafeeq. Got "${targetRaw}".`,
      400,
    );
  }
  const target: MarketplaceTarget = parsed.data;

  const product = await products.findBySku(ctx.params.sku);
  const result = checkReadiness(product, target);

  return ok(result);
});
