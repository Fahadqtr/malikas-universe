/**
 * Standalone Supabase client for non-Next contexts (workers, scripts).
 * Next.js apps should use their own `lib/supabase/server.ts` factory.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export function createDbClient(opts: {
  url: string;
  key: string;
  serviceRole?: boolean;
}): SupabaseClient<Database> {
  return createClient<Database>(opts.url, opts.key, {
    auth: {
      autoRefreshToken: !opts.serviceRole,
      persistSession: !opts.serviceRole,
    },
  });
}

export type { Database } from './types';
