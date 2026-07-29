/**
 * Unit tests for the login page's pure helpers (redirect safety + password
 * validation). The Supabase browser client is mocked so importing the page
 * module doesn't pull the env-validating client chain under Vitest's node env.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({
  createBrowserSupabaseClient: vi.fn(),
}));

import { safeInternalPath, validateNewPassword } from '../page';

describe('safeInternalPath', () => {
  it('keeps internal absolute paths (incl. query)', () => {
    expect(safeInternalPath('/bulk-ai')).toBe('/bulk-ai');
    expect(safeInternalPath('/bulk-ai/recover?limit=50&offset=0')).toBe('/bulk-ai/recover?limit=50&offset=0');
    expect(safeInternalPath('/')).toBe('/');
  });

  it('falls back to "/" for empty/missing input', () => {
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath(undefined)).toBe('/');
    expect(safeInternalPath('')).toBe('/');
  });

  it('rejects external and protocol-relative URLs', () => {
    expect(safeInternalPath('https://evil.com')).toBe('/');
    expect(safeInternalPath('http://evil.com/path')).toBe('/');
    expect(safeInternalPath('//evil.com')).toBe('/');
    expect(safeInternalPath('/\\evil.com')).toBe('/');
    expect(safeInternalPath('javascript:alert(1)')).toBe('/');
  });

  it('rejects non-absolute paths and whitespace tricks', () => {
    expect(safeInternalPath('bulk-ai')).toBe('/');
    expect(safeInternalPath('/foo\nbar')).toBe('/');
    expect(safeInternalPath('/foo bar')).toBe('/');
  });
});

describe('validateNewPassword', () => {
  it('accepts a matching password of at least 12 chars', () => {
    expect(validateNewPassword('abcdefghijkl', 'abcdefghijkl')).toEqual({ ok: true });
    expect(validateNewPassword('Str0ng-Passw0rd!', 'Str0ng-Passw0rd!')).toEqual({ ok: true });
  });

  it('rejects passwords shorter than 12 chars', () => {
    const r = validateNewPassword('short', 'short');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least 12/i);
  });

  it('rejects mismatched passwords', () => {
    const r = validateNewPassword('abcdefghijkl', 'abcdefghijkX');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/do not match/i);
  });

  it('checks length before match (short + mismatched → length error)', () => {
    const r = validateNewPassword('short', 'different');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least 12/i);
  });
});
