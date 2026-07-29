/**
 * Pure, dependency-free authentication policy helpers for the Next.js
 * middleware. Extracted so the security-critical decisions (which paths are
 * public, and whether the local dev auth-bypass may run) can be unit-tested in
 * isolation, without spinning up Next.js, Supabase, or any network I/O.
 *
 * SECURITY MODEL — the middleware fails CLOSED:
 *   • Only the exact public routes below (matched EXACTLY) and an explicit
 *     static-asset allowlist skip authentication.
 *   • Everything else — including dotted paths like `/admin/report.csv` — is
 *     treated as protected and must pass the normal Supabase session check.
 *   • The `SKIP_AUTH` dev bypass is only honoured in genuine local development
 *     (see {@link isAuthBypassAllowed}); in staging/production it is ignored.
 */

/**
 * The ONLY routes served without a session. Matched EXACTLY (see
 * {@link isPublicPath}) — never as a prefix or segment boundary — so lookalike
 * paths (`/login-admin`, `/api/healthcheck`, `/api/whatsapp/webhook.evil`) AND
 * any nested sub-path (`/login/x`, `/api/whatsapp/webhook/x`) remain protected.
 * There are no public sub-routes today; exact match fails closed, which is
 * especially important for the WhatsApp webhook path.
 *
 *   • /login                — the sign-in page
 *   • /auth/callback        — Supabase OAuth/redirect callback
 *   • /auth/recovery        — prefetch-safe password-reset landing page
 *   • /api/health           — unauthenticated health probe
 *   • /api/whatsapp/webhook — Meta webhook; authenticated via HMAC, not session
 *
 * Exact match keeps `/auth/recovery` public while `/auth/recovery/`,
 * `/auth/recovery/anything`, `/auth/recovery.evil` and `/auth/recover` stay
 * protected.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/login',
  '/auth/callback',
  '/auth/recovery',
  '/api/health',
  '/api/whatsapp/webhook',
];

/**
 * Explicit allowlist of public static assets that may be served without auth.
 *
 * This repo has NO `apps/web/public/` directory — there are no committed public
 * assets — so this list is intentionally empty. Next.js build output
 * (`/_next/static`, `/_next/image`) and `favicon.ico` are already excluded by
 * the middleware `matcher`, and remaining `/_next/*` paths are handled by
 * {@link isNextInternalPath}.
 *
 * If real public assets are ever added under `apps/web/public/`, add their
 * EXACT request paths (e.g. `/robots.txt`, `/icons/logo.svg`) here — one entry
 * per file/known path. Do NOT re-introduce a broad `pathname.includes('.')`
 * rule: that would make every dotted protected route public.
 */
export const PUBLIC_ASSET_PATHS: readonly string[] = [];

/**
 * True for Next.js internal paths (`/_next` and everything beneath it). These
 * carry build assets and RSC/data payloads, never protected user content.
 */
export function isNextInternalPath(pathname: string): boolean {
  return pathname === '/_next' || pathname.startsWith('/_next/');
}

/**
 * True only when `pathname` EXACTLY equals one of {@link PUBLIC_PATHS}. `/login`
 * matches only `/login` — NOT `/login-admin`, NOT `/login/x`;
 * `/api/whatsapp/webhook` matches only itself — NOT `/api/whatsapp/webhook.evil`
 * and NOT `/api/whatsapp/webhook/x`. Nested and lookalike routes stay protected.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

/**
 * True only for an exact match against {@link PUBLIC_ASSET_PATHS}. Exact match
 * (not prefix, not extension) keeps protected dotted routes protected.
 */
export function isPublicAsset(pathname: string): boolean {
  return PUBLIC_ASSET_PATHS.includes(pathname);
}

/**
 * True when the request needs NO authentication: a Next internal path, an
 * allowlisted public route, or an allowlisted public asset. Everything else is
 * protected.
 */
export function isUnprotectedPath(pathname: string): boolean {
  return (
    isNextInternalPath(pathname) ||
    isPublicPath(pathname) ||
    isPublicAsset(pathname)
  );
}

/** Minimal shape of the env vars that gate the dev auth bypass. */
export interface AuthBypassEnv {
  SKIP_AUTH?: string;
  APP_ENV?: string;
  NODE_ENV?: string;
}

/**
 * Whether the local-development auth bypass may run. FAILS CLOSED: returns
 * `true` ONLY when all three hold simultaneously —
 *
 *   • SKIP_AUTH === 'true'
 *   • APP_ENV === 'local'
 *   • NODE_ENV !== 'production'
 *
 * Any other combination (missing APP_ENV, APP_ENV `staging`/`prod`,
 * NODE_ENV `production`, SKIP_AUTH unset/`false`) returns `false`, so normal
 * authentication is enforced. This is deliberately stricter than reading a bare
 * `SKIP_AUTH` boolean, which has no production guard.
 */
export function isAuthBypassAllowed(env: AuthBypassEnv): boolean {
  return (
    env.SKIP_AUTH === 'true' &&
    env.APP_ENV === 'local' &&
    env.NODE_ENV !== 'production'
  );
}
