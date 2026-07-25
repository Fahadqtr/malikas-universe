/**
 * Unit tests for verifyWhatsappWebhookSignature.
 *
 * All signatures are generated LOCALLY with node:crypto — no Meta, no network.
 * These tests prove the verifier is correct AND that it must run against the
 * RAW body (re-serialized / whitespace-changed JSON must fail).
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyWhatsappWebhookSignature } from '../whatsapp-signature';

const APP_SECRET = 'test_app_secret_do_not_use_in_prod';

/** Helper: produce the header value Meta would send for a given body+secret. */
function sign(body: string, secret: string = APP_SECRET): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(Buffer.from(body, 'utf8'))
    .digest('hex');
  return `sha256=${digest}`;
}

describe('verifyWhatsappWebhookSignature', () => {
  it('1. accepts a correct signature', () => {
    const body = JSON.stringify({ entry: [{ id: '1' }] });
    const res = verifyWhatsappWebhookSignature(body, sign(body), APP_SECRET);
    expect(res.valid).toBe(true);
  });

  it('2. rejects when signed with the wrong secret', () => {
    const body = JSON.stringify({ hello: 'world' });
    const badHeader = sign(body, 'a_different_secret');
    const res = verifyWhatsappWebhookSignature(body, badHeader, APP_SECRET);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('mismatch');
  });

  it('3. rejects when the body was tampered with after signing', () => {
    const original = JSON.stringify({ amount: 100 });
    const header = sign(original);
    const tampered = JSON.stringify({ amount: 999 });
    const res = verifyWhatsappWebhookSignature(tampered, header, APP_SECRET);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('mismatch');
  });

  it('4. rejects a missing header', () => {
    const body = '{}';
    expect(verifyWhatsappWebhookSignature(body, null, APP_SECRET)).toEqual({
      valid: false,
      reason: 'signature_missing',
    });
    expect(verifyWhatsappWebhookSignature(body, undefined, APP_SECRET)).toEqual({
      valid: false,
      reason: 'signature_missing',
    });
    expect(verifyWhatsappWebhookSignature(body, '', APP_SECRET)).toEqual({
      valid: false,
      reason: 'signature_missing',
    });
  });

  it('5. rejects a malformed header (no "=" / no digest)', () => {
    const body = '{}';
    expect(
      verifyWhatsappWebhookSignature(body, 'garbage-no-equals', APP_SECRET).valid,
    ).toBe(false);
    // present prefix but empty digest
    expect(verifyWhatsappWebhookSignature(body, 'sha256=', APP_SECRET)).toEqual({
      valid: false,
      reason: 'signature_malformed',
    });
    // non-hex digest of correct length
    const nonHex = 'z'.repeat(64);
    expect(
      verifyWhatsappWebhookSignature(body, `sha256=${nonHex}`, APP_SECRET),
    ).toEqual({ valid: false, reason: 'signature_malformed' });
  });

  it('6. rejects a non-"sha256=" prefix (wrong algorithm)', () => {
    const body = JSON.stringify({ a: 1 });
    const digest = crypto
      .createHmac('sha1', APP_SECRET)
      .update(Buffer.from(body, 'utf8'))
      .digest('hex');
    const res = verifyWhatsappWebhookSignature(body, `sha1=${digest}`, APP_SECRET);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('unsupported_algorithm');
  });

  it('7. rejects a digest of the wrong length', () => {
    const body = '{}';
    const shortDigest = 'ab12'; // valid hex, wrong length
    expect(
      verifyWhatsappWebhookSignature(body, `sha256=${shortDigest}`, APP_SECRET),
    ).toEqual({ valid: false, reason: 'invalid_length' });
  });

  it('8. rejects safely when the app secret is empty/missing (fail closed)', () => {
    const body = JSON.stringify({ a: 1 });
    const header = sign(body);
    expect(verifyWhatsappWebhookSignature(body, header, '')).toEqual({
      valid: false,
      reason: 'app_secret_missing',
    });
    expect(verifyWhatsappWebhookSignature(body, header, undefined)).toEqual({
      valid: false,
      reason: 'app_secret_missing',
    });
    expect(verifyWhatsappWebhookSignature(body, header, null)).toEqual({
      valid: false,
      reason: 'app_secret_missing',
    });
  });

  it('9. correctly signs and verifies a Unicode / Arabic body', () => {
    const body = JSON.stringify({
      entry: [{ changes: [{ value: { text: 'مرحبا بك في عالم ماليكا 🌟' } }] }],
    });
    const res = verifyWhatsappWebhookSignature(body, sign(body), APP_SECRET);
    expect(res.valid).toBe(true);
    // sanity: tampering with the Arabic content breaks it
    const tampered = body.replace('مرحبا', 'وداعا');
    expect(
      verifyWhatsappWebhookSignature(tampered, sign(body), APP_SECRET).valid,
    ).toBe(false);
  });

  it('10. a signature over differently-whitespaced JSON is rejected (proves raw-body matters)', () => {
    const compact = JSON.stringify({ b: 2, a: 1 });
    const header = sign(compact);
    // Same logical JSON, different bytes (pretty-printed) → must fail.
    const pretty = JSON.stringify({ b: 2, a: 1 }, null, 2);
    expect(compact).not.toBe(pretty);
    const res = verifyWhatsappWebhookSignature(pretty, header, APP_SECRET);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toBe('mismatch');
    // and the exact raw bytes still verify
    expect(verifyWhatsappWebhookSignature(compact, header, APP_SECRET).valid).toBe(
      true,
    );
  });
});
