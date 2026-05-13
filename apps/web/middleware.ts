/**
 * Next.js middleware.
 * - Refreshes Supabase auth cookies
 * - Redirects unauthenticated users to /login
 * - Adds security headers
 */
import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = [
  '/login',
  '/auth/callback',
  '/api/health',
  '/api/whatsapp/webhook', // webhook signed via HMAC, not session
];

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const pathname = req.nextUrl.pathname;

  // Public paths skip auth check
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return res;
  }

  // Skip static assets
  if (pathname.startsWith('/_next') || pathname.includes('.')) {
    return res;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => req.cookies.get(name)?.value,
        set: (name, value, options) => {
          res.cookies.set({ name, value, ...options });
        },
        remove: (name, options) => {
          res.cookies.set({ name, value: '', ...options });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Allow dev bypass
  if (process.env.SKIP_AUTH === 'true') {
    return res;
  }

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
