/**
 * Supabase server client.
 * Uses service-role key for full DB access — NEVER expose to browser.
 * Use this in Server Components, Route Handlers, Server Actions.
 */
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@malikas/db';
import { env } from '@/lib/env';

/**
 * Authenticated user client (respects RLS based on auth.uid()).
 * Use for: user-facing API routes, Server Components reading user data.
 */
export function createServerSupabaseClient() {
  const cookieStore = cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: Record<string, unknown>) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // ignore — called from Server Component
          }
        },
        remove(name: string, options: Record<string, unknown>) {
          try {
            cookieStore.set({ name, value: '', ...options });
          } catch {
            // ignore
          }
        },
      },
    },
  );
}

/**
 * Admin client — bypasses RLS.
 * Use ONLY for: background jobs, webhooks, sync workflows, admin scripts.
 * Never expose to user requests without explicit role check.
 */
import { createClient } from '@supabase/supabase-js';

export function createAdminSupabaseClient() {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY not configured');
  }

  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
