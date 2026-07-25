/**
 * Standard API response envelope.
 * Every API route returns one of these.
 */
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

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
      if (e instanceof ZodError) {
        return err('VALIDATION_ERROR', 'Invalid input', 400, e.flatten());
      }
      if (e instanceof Error) {
        console.error('[API Error]', e);
        return err('INTERNAL_ERROR', e.message, 500);
      }
      console.error('[API Error] Unknown error', e);
      return err('INTERNAL_ERROR', 'Unknown error', 500);
    }
  };
}
