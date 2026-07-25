/**
 * ServiceError — the single typed error used across services and authorization.
 *
 * LEAF module (no imports) so it can be shared without cycles. Previously this
 * lived in `services/base.service.ts`; it now lives here and is re-exported from
 * there (and from `@/lib/services`) so existing imports keep working.
 *
 * `status` drives the HTTP response in `withErrorHandling`. `message` must be
 * safe to return to clients for 4xx codes; for 5xx the wrapper replaces it with
 * a generic message and logs the original server-side.
 */
export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
