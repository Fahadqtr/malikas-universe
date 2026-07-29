/**
 * Tests for the prefetch-safe recovery page: pure helpers + a source contract
 * proving the token is never auto-verified on load (Gmail-prefetch protection).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseRecoveryHash,
  isValidRecoveryParams,
  validateNewPassword,
  RECOVERY_ERRORS,
} from '../recovery-logic';

describe('parseRecoveryHash', () => {
  it('parses token_hash + type from a fragment (with or without leading #)', () => {
    expect(parseRecoveryHash('#token_hash=abc123&type=recovery')).toEqual({ tokenHash: 'abc123', type: 'recovery' });
    expect(parseRecoveryHash('token_hash=xyz&type=recovery')).toEqual({ tokenHash: 'xyz', type: 'recovery' });
  });
  it('returns nulls for empty/missing input', () => {
    expect(parseRecoveryHash('')).toEqual({ tokenHash: null, type: null });
    expect(parseRecoveryHash(null)).toEqual({ tokenHash: null, type: null });
    expect(parseRecoveryHash('#type=recovery')).toEqual({ tokenHash: null, type: 'recovery' });
  });
});

describe('isValidRecoveryParams', () => {
  it('accepts only type=recovery with a non-empty token hash', () => {
    expect(isValidRecoveryParams('recovery', 'abc')).toBe(true);
    expect(isValidRecoveryParams('recovery', '')).toBe(false);
    expect(isValidRecoveryParams('recovery', null)).toBe(false);
    expect(isValidRecoveryParams('signup', 'abc')).toBe(false);
    expect(isValidRecoveryParams(null, 'abc')).toBe(false);
  });
});

describe('validateNewPassword', () => {
  it('accepts a matching password of at least 12 chars', () => {
    expect(validateNewPassword('abcdefghijkl', 'abcdefghijkl')).toEqual({ ok: true });
  });
  it('rejects short passwords', () => {
    const r = validateNewPassword('short', 'short');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least 12/i);
  });
  it('rejects mismatched passwords', () => {
    const r = validateNewPassword('abcdefghijkl', 'abcdefghijkX');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/do not match/i);
  });
});

describe('RECOVERY_ERRORS are safe generic strings', () => {
  it('contains no raw-error markers', () => {
    const all = Object.values(RECOVERY_ERRORS).join(' ');
    expect(all).not.toMatch(/token|stack|supabase|jwt/i);
  });
});

// ─── Source contract: prefetch safety ─────────────────────────────────────────
describe('page source contract (prefetch-safe)', () => {
  const rawSrc = readFileSync(path.resolve(__dirname, '..', 'page.tsx'), 'utf8');
  // Strip block + line comments so the contract checks the CODE, not prose that
  // happens to mention verifyOtp / localStorage in doc comments.
  const pageSrc = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Isolate the on-load useEffect body: from the first `useEffect(` to its
  // closing `}, []);`.
  const effStart = pageSrc.indexOf('useEffect(');
  const effEnd = pageSrc.indexOf('}, []);', effStart);
  const effectBody = pageSrc.slice(effStart, effEnd);

  it('does NOT call verifyOtp inside the on-load useEffect', () => {
    expect(effStart).toBeGreaterThan(-1);
    expect(effEnd).toBeGreaterThan(effStart);
    expect(effectBody).not.toContain('verifyOtp');
  });

  it('verifies only in a click handler (verifyOtp exists, after the effect)', () => {
    const verifyIdx = pageSrc.indexOf('verifyOtp');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(effEnd); // outside/after the load effect
    expect(pageSrc).toContain('function handleContinue');
    expect(pageSrc).toContain('onClick={handleContinue}');
  });

  it('clears the URL hash on load (inside the effect)', () => {
    expect(effectBody).toContain('history.replaceState');
  });

  it('never persists the token to web storage or cookies', () => {
    expect(pageSrc).not.toMatch(/localStorage|sessionStorage/);
    expect(pageSrc).not.toMatch(/document\.cookie/);
  });

  it('guards verify/update against double-submit with a ref lock', () => {
    expect(pageSrc).toContain('busyRef');
    // the continue handler bails out when already busy
    const cont = pageSrc.slice(pageSrc.indexOf('function handleContinue'));
    expect(cont).toMatch(/if\s*\(\s*busyRef\.current\s*\)\s*return/);
  });

  it('keeps the token only in a ref, not React state', () => {
    expect(pageSrc).toContain('tokenHashRef');
  });
});
