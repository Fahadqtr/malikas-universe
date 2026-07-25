/**
 * Standard API response envelope.
 * Every API route returns one of these.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ServiceError } from '@/lib/authz/errors';

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function ok<T>(data: T, status = 200): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ ok: true, data }, { status });
}

export function err(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
): NextResponse<ApiError> {
  return NextResponse.json(
    { ok: false, error: { code, message, details } },
    { status },
  );
}

/**
 * Wrap a route handler with standard error handling.
 *
 * Usage:
 *   export const GET = withErrorHandling(async (req) => {
 *     const data = await fetchSomething();
 *     return ok(data);
 *   });
 */
export function withErrorHandling<Args extends unknown[]>(
  // Handlers return `ok(...)` (NextResponse<ApiSuccess<T>>) OR `err(...)`
  // (NextResponse<ApiError>). Those are different NextResponse<...> generics, so
  // there is no single `R` to unify. Type the parameter as the unparameterised
  // NextResponse (NextResponse<unknown>), which both branches are assignable to —
  // no `any`, and the envelope is still enforced at the `ok`/`err` helpers.
  handler: (...args: Args) => Promise<NextResponse>,
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (e) {
      // Input validation → 400 with the safe, structured Zod details.
      if (e instanceof ZodError) {
        return err('VALIDATION_ERROR', 'Invalid input', 400, e.flatten());
      }

      // Typed service/authorization errors carry a safe code + status.
      if (e instanceof ServiceError) {
        // 5xx ServiceErrors are still server faults: log fully, return generic.
        if (e.status >= 500) {
          console.error('[API ServiceError 5xx]', e);
          return err(e.code || 'INTERNAL_ERROR', 'Internal server error', e.status);
        }
        // 4xx (UNAUTHORIZED/FORBIDDEN/NO_PROFILE/INACTIVE/NOT_FOUND/CONFLICT/…):
        // developer-authored, client-safe message. Forward `details` only for
        // 400 (client input) and only when present — never for auth failures.
        const safeDetails = e.status === 400 ? e.details : undefined;
        return err(e.code, e.message, e.status, safeDetails);
      }

      // Any other Error (incl. raw Supabase/Postgres errors): never leak the
      // message, SQL, or stack to the client. Log server-side; return generic.
      console.error('[API Error]', e);
      return err('INTERNAL_ERROR', 'Internal server error', 500);
    }
  };
}
