/**
 * Next.js middleware.
 * - Refreshes Supabase auth cookies
 * - Redirects unauthenticated users to /login
 *
 * Auth policy (which paths are public, and whether the local dev bypass may
 * run) lives in `@/lib/middleware-auth` as pure, unit-tested helpers. The
 * middleware FAILS CLOSED: anything not explicitly public requires a session,
 * and the `SKIP_AUTH` bypass only runs in genuine local development.
 */
import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';
import { isUnprotectedPath, isAuthBypassAllowed } from '@/lib/middleware-auth';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const pathname = req.nextUrl.pathname;

  // Next internals, the explicit public routes, and allowlisted public assets
  // skip auth. Everything else (incl. dotted paths like /admin/report.csv) is
  // protected.
  if (isUnprotectedPath(pathname)) {
    return res;
  }

  // Local-only dev bypass — evaluated BEFORE creating a Supabase client or
  // making any network call. Fails closed in staging/production.
  if (isAuthBypassAllowed(process.env)) {
    return res;
  }

  // SKIP_AUTH requested but NOT permitted here (e.g. staging/production, or
  // APP_ENV missing): ignore it and enforce normal auth. Generic warning only —
  // never log cookies, tokens, or user data.
  if (process.env.SKIP_AUTH === 'true') {
    console.warn(
      '[middleware] SKIP_AUTH is set but ignored outside local development; enforcing normal authentication',
    );
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name: string) => req.cookies.get(name)?.value,
        set: (name: string, value: string, options: Record<string, unknown>) => {
          res.cookies.set({ name, value, ...options });
        },
        remove: (name: string, options: Record<string, unknown>) => {
          res.cookies.set({ name, value: '', ...options });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
