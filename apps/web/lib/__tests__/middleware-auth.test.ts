/**
 * Unit tests for the pure middleware auth-policy helpers.
 *
 * Covers path classification (public vs protected, incl. the dotted-path and
 * lookalike-prefix attack cases) and the fail-closed SKIP_AUTH policy.
 */
import { describe, it, expect } from 'vitest';
import {
  isPublicPath,
  isPublicAsset,
  isNextInternalPath,
  isUnprotectedPath,
  isAuthBypassAllowed,
  PUBLIC_ASSET_PATHS,
} from '../middleware-auth';

describe('isPublicPath — the four exact public routes', () => {
  it.each(['/login', '/auth/callback', '/api/health', '/api/whatsapp/webhook'])(
    'treats %s as public',
    (p) => {
      expect(isPublicPath(p)).toBe(true);
    },
  );

  it.each([
    // lookalike prefixes
    '/login-admin',
    '/api/healthcheck',
    '/api/whatsapp/webhook.evil',
    '/loginX',
    // nested sub-paths of public routes (exact match → protected, fail-closed)
    '/login/',
    '/login/anything',
    '/auth/callback/anything',
    '/api/health/anything',
    '/api/whatsapp/webhook/anything',
    // ordinary protected + dotted paths
    '/admin/report.csv',
    '/api/orders/1.2',
    '/products/private.json',
    '/api/whatsapp/status',
    '/api/whatsapp/send-test',
    '/',
    '/admin',
  ])('treats %s as protected', (p) => {
    expect(isPublicPath(p)).toBe(false);
  });
});

describe('isNextInternalPath', () => {
  it('allows /_next and its subpaths', () => {
    expect(isNextInternalPath('/_next')).toBe(true);
    expect(isNextInternalPath('/_next/static/chunk.js')).toBe(true);
    expect(isNextInternalPath('/_next/data/x.json')).toBe(true);
  });
  it('does not allow lookalikes', () => {
    expect(isNextInternalPath('/_nextfake')).toBe(false);
    expect(isNextInternalPath('/next')).toBe(false);
    expect(isNextInternalPath('/admin/_next')).toBe(false);
  });
});

describe('isPublicAsset — exact allowlist only', () => {
  it('is empty in this repo (no apps/web/public assets committed)', () => {
    expect(PUBLIC_ASSET_PATHS).toHaveLength(0);
  });
  it('never allows arbitrary dotted paths', () => {
    expect(isPublicAsset('/admin/report.csv')).toBe(false);
    expect(isPublicAsset('/logo.png')).toBe(false);
    expect(isPublicAsset('/robots.txt')).toBe(false);
  });
});

describe('isUnprotectedPath — combined gate', () => {
  it('is true for public routes and next internals', () => {
    expect(isUnprotectedPath('/login')).toBe(true);
    expect(isUnprotectedPath('/api/whatsapp/webhook')).toBe(true);
    expect(isUnprotectedPath('/_next/static/x.js')).toBe(true);
  });
  it('is false for protected + dotted paths', () => {
    expect(isUnprotectedPath('/admin/report.csv')).toBe(false);
    expect(isUnprotectedPath('/api/orders/1.2')).toBe(false);
    expect(isUnprotectedPath('/products/private.json')).toBe(false);
    expect(isUnprotectedPath('/api/whatsapp/webhook.evil')).toBe(false);
    expect(isUnprotectedPath('/login-admin')).toBe(false);
  });
  it('is false for nested sub-paths of public routes (exact-match fail-closed)', () => {
    expect(isUnprotectedPath('/login/anything')).toBe(false);
    expect(isUnprotectedPath('/auth/callback/anything')).toBe(false);
    expect(isUnprotectedPath('/api/health/anything')).toBe(false);
    expect(isUnprotectedPath('/api/whatsapp/webhook/anything')).toBe(false);
  });
});

describe('isAuthBypassAllowed — fails closed', () => {
  it('allows bypass only for SKIP_AUTH=true + APP_ENV=local + non-production', () => {
    expect(
      isAuthBypassAllowed({ SKIP_AUTH: 'true', APP_ENV: 'local', NODE_ENV: 'development' }),
    ).toBe(true);
    expect(
      isAuthBypassAllowed({ SKIP_AUTH: 'true', APP_ENV: 'local', NODE_ENV: 'test' }),
    ).toBe(true);
  });

  it('forbids bypass in production even with APP_ENV=local', () => {
    expect(
      isAuthBypassAllowed({ SKIP_AUTH: 'true', APP_ENV: 'local', NODE_ENV: 'production' }),
    ).toBe(false);
  });

  it('forbids bypass when NODE_ENV=production regardless of APP_ENV', () => {
    expect(isAuthBypassAllowed({ SKIP_AUTH: 'true', NODE_ENV: 'production' })).toBe(false);
  });

  it('forbids bypass for staging/prod APP_ENV', () => {
    expect(
      isAuthBypassAllowed({ SKIP_AUTH: 'true', APP_ENV: 'staging', NODE_ENV: 'development' }),
    ).toBe(false);
    expect(
      isAuthBypassAllowed({ SKIP_AUTH: 'true', APP_ENV: 'prod', NODE_ENV: 'development' }),
    ).toBe(false);
  });

  it('forbids bypass when APP_ENV is missing', () => {
    expect(isAuthBypassAllowed({ SKIP_AUTH: 'true', NODE_ENV: 'development' })).toBe(false);
  });

  it('forbids bypass when SKIP_AUTH is false or missing', () => {
    expect(
      isAuthBypassAllowed({ SKIP_AUTH: 'false', APP_ENV: 'local', NODE_ENV: 'development' }),
    ).toBe(false);
    expect(isAuthBypassAllowed({ APP_ENV: 'local', NODE_ENV: 'development' })).toBe(false);
    expect(isAuthBypassAllowed({})).toBe(false);
  });
});
