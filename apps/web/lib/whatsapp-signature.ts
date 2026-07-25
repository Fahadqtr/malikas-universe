/**
 * WhatsApp (Meta) webhook signature verification.
 *
 * Meta signs every webhook POST body with an HMAC-SHA256 keyed on your
 * **App Secret** and sends it in the `X-Hub-Signature-256` header as:
 *
 *     X-Hub-Signature-256: sha256=<hex digest>
 *
 * This module verifies that signature over the RAW request body. It is
 * intentionally dependency-free (only `node:crypto`) so it can be unit-tested
 * in isolation without pulling in Supabase, Next.js, or any I/O.
 *
 * IMPORTANT — three DIFFERENT WhatsApp secrets, do not confuse them:
 *   • WHATSAPP_APP_SECRET   — Meta *App Secret*. Used ONLY here, to verify the
 *                             HMAC signature of inbound webhook POSTs.
 *   • WHATSAPP_VERIFY_TOKEN — the string you invent and paste into Meta's
 *                             webhook config; echoed back during the GET
 *                             handshake. NOT used for HMAC.
 *   • WHATSAPP_TOKEN        — the access token used to CALL the Graph API
 *                             (send messages). NOT used for HMAC.
 *
 * Security properties:
 *   • Uses crypto.timingSafeEqual (constant-time comparison).
 *   • Rejects missing / malformed / wrong-algorithm / wrong-length signatures.
 *   • Rejects an empty/missing App Secret (fail closed) without throwing.
 *   • Never logs the App Secret or the full signature value.
 *   • Returns a plain result object; never throws on bad input.
 */
import crypto from 'node:crypto';

/** Distinct machine-readable reasons so the caller can pick the HTTP status. */
export type WhatsappSignatureReason =
  | 'app_secret_missing' // server misconfigured → caller should answer 503
  | 'signature_missing' // header absent → 401
  | 'signature_malformed' // header not `sha256=<hex>` → 401
  | 'unsupported_algorithm' // prefix present but not `sha256=` → 401
  | 'invalid_length' // hex digest is not 64 chars → 401
  | 'mismatch'; // well-formed but does not match → 401

export type WhatsappSignatureResult =
  | { valid: true }
  | { valid: false; reason: WhatsappSignatureReason };

/** SHA-256 hex digest is always 32 bytes → 64 hex chars. */
const SHA256_HEX_LENGTH = 64;
const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Verify a Meta `X-Hub-Signature-256` header against the raw request body.
 *
 * @param rawBody          the EXACT bytes/text of the request body (from
 *                         `await req.text()`), NOT a re-serialized JSON object.
 * @param signatureHeader  the value of the `X-Hub-Signature-256` header
 *                         (e.g. `sha256=ab12…`), or null/undefined if absent.
 * @param appSecret        the Meta App Secret (`WHATSAPP_APP_SECRET`).
 * @returns `{ valid: true }` or `{ valid: false, reason }` — never throws.
 */
export function verifyWhatsappWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string | null | undefined,
): WhatsappSignatureResult {
  // Fail closed: no App Secret configured → cannot verify anything.
  if (!appSecret || appSecret.length === 0) {
    return { valid: false, reason: 'app_secret_missing' };
  }

  // Header must be present and a non-empty string.
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return { valid: false, reason: 'signature_missing' };
  }

  // Must be exactly `<algo>=<digest>` with a single '='.
  const sep = signatureHeader.indexOf('=');
  if (sep <= 0 || sep === signatureHeader.length - 1) {
    return { valid: false, reason: 'signature_malformed' };
  }
  const algo = signatureHeader.slice(0, sep);
  const provided = signatureHeader.slice(sep + 1);

  // Only SHA-256 is accepted (reject sha1, plaintext, etc.).
  if (algo !== 'sha256') {
    return { valid: false, reason: 'unsupported_algorithm' };
  }

  // A valid digest is 64 lowercase/uppercase hex chars.
  if (provided.length !== SHA256_HEX_LENGTH) {
    return { valid: false, reason: 'invalid_length' };
  }
  if (!HEX64.test(provided)) {
    return { valid: false, reason: 'signature_malformed' };
  }

  // Compute the expected HMAC over the raw body bytes (UTF-8).
  let expected: string;
  try {
    expected = crypto
      .createHmac('sha256', appSecret)
      .update(Buffer.from(rawBody, 'utf8'))
      .digest('hex');
  } catch {
    // Defensive: never throw out of this function.
    return { valid: false, reason: 'mismatch' };
  }

  // Constant-time compare. Both buffers are guaranteed 32 bytes here.
  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'invalid_length' };
  }
  const match = crypto.timingSafeEqual(providedBuf, expectedBuf);
  return match ? { valid: true } : { valid: false, reason: 'mismatch' };
}
