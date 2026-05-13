/**
 * GET /auth/callback?code=...&next=/
 * Handles Supabase magic-link / email-confirmation redirects.
 * Exchanges the auth code for a session cookie, then redirects to `next`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/';

  if (code) {
    const supabase = createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const errUrl = new URL('/login', url.origin);
      errUrl.searchParams.set('error', error.message);
      return NextResponse.redirect(errUrl);
    }
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
