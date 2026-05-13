/**
 * Health check endpoint.
 * GET /api/health → 200 with status JSON
 * Used by uptime monitor + load balancer probes.
 */
import { ok, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';

export const GET = withErrorHandling(async () => {
  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.from('categories').select('id').limit(1);

  return ok({
    status: error ? 'degraded' : 'healthy',
    database: error ? 'unreachable' : 'reachable',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.1.0',
  });
});
