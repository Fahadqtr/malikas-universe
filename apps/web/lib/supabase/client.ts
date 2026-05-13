/**
 * Supabase browser client.
 * Uses ANON key — safe to expose. RLS enforces access control.
 * Use in: Client Components, browser-side queries.
 */
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@malikas/db';
import { env } from '@/lib/env';

export function createBrowserSupabaseClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
