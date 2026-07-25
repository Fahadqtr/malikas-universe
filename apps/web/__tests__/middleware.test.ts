/**
 * Integration tests for the Next.js middleware.
 *
 * `@supabase/ssr` is mocked so NO real network call is made; we assert on
 * whether a Supabase client / getUser was created at all, and on the
 * redirect-vs-passthrough outcome. Env is stubbed with `vi.stubEnv` and
 * restored via `vi.unstubAllEnvs()` after each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { createServerClientMock, getUserMock } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const createServerClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
  return { createServerClientMock, getUserMock };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: createServerClientMock,
}));

import { NextRequest } from 'next/server';
import { middleware } from '../middleware';

function req(path: string): NextRequest {
  return new NextRequest(new URL(`http://localhost${path}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Values only forwarded to the mocked client; no real client is built.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ci.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'ci-anon');
  // Default: no bypass (SKIP_AUTH not 'true').
  vi.stubEnv('SKIP_AUTH', '');
  vi.stubEnv('APP_ENV', 'local');
  vi.stubEnv('NODE_ENV', 'development');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('middleware — protected dotted path, unauthenticated', () => {
  it('calls getUser and redirects /admin/report.csv to /login', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await middleware(req('/admin/report.csv'));

    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('redirect')).toBe('/admin/report.csv');
  });
});

describe('middleware — lookalike public prefix is protected', () => {
  it('does not treat /login-admin as public; redirects to /login', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await middleware(req('/login-admin'));

    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    expect(loc.searchParams.get('redirect')).toBe('/login-admin');
  });

  it('does not treat /api/whatsapp/webhook.evil as public', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await middleware(req('/api/whatsapp/webhook.evil'));

    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
  });

  it('does not treat a nested /api/whatsapp/webhook/anything as public', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await middleware(req('/api/whatsapp/webhook/anything'));

    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
  });
});

describe('middleware — genuine public route', () => {
  it('lets /api/whatsapp/webhook through WITHOUT creating a client or calling getUser', async () => {
    const res = await middleware(req('/api/whatsapp/webhook'));

    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe('middleware — local dev bypass (allowed)', () => {
  it('passes a protected path WITHOUT creating a Supabase client', async () => {
    vi.stubEnv('SKIP_AUTH', 'true');
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('NODE_ENV', 'development');

    const res = await middleware(req('/admin'));

    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(getUserMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe('middleware — SKIP_AUTH in production (forbidden)', () => {
  it('ignores the bypass and redirects an unauthenticated user', async () => {
    vi.stubEnv('SKIP_AUTH', 'true');
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('NODE_ENV', 'production');
    getUserMock.mockResolvedValue({ data: { user: null } });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await middleware(req('/admin'));

    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/login');
    // A generic warning is emitted — but never secrets/cookies/user data.
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('middleware — authenticated user', () => {
  it('passes through (no redirect) when a session exists', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'u1' } } });
    const res = await middleware(req('/admin'));

    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    expect(getUserMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
