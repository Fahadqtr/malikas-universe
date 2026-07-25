/**
 * Unit tests for withErrorHandling(): typed ServiceErrors keep their status,
 * 5xx / unknown errors never leak internal messages, ZodError → 400, and
 * success responses are untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { withErrorHandling, ok } from '../api-response';
import { ServiceError } from '@/lib/authz/errors';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

function run(handler: () => Promise<Response>) {
  return withErrorHandling(handler as never)();
}

it('1. ServiceError 401 → 401 envelope with code', async () => {
  const res = await run(async () => { throw new ServiceError('UNAUTHORIZED', 'Login required', 401); });
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Login required' } });
});

it('2. ServiceError 403 → 403', async () => {
  const res = await run(async () => { throw new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403); });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN');
});

it('3. ServiceError 404 → 404', async () => {
  const res = await run(async () => { throw new ServiceError('NOT_FOUND', 'Missing', 404); });
  expect(res.status).toBe(404);
});

it('4. ServiceError 409 → 409', async () => {
  const res = await run(async () => { throw new ServiceError('CONFLICT', 'Already exists', 409); });
  expect(res.status).toBe(409);
});

it('5. ServiceError 500 with sensitive SQL → 500, message hidden, logged', async () => {
  const secret = 'duplicate key value violates unique constraint "products_pkey"';
  const res = await run(async () => { throw new ServiceError('DB_ERROR', secret, 500); });
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(JSON.stringify(body)).not.toContain('products_pkey');
  expect(body.error.message).toBe('Internal server error');
  expect(errSpy).toHaveBeenCalled();
});

it('6. generic Error with secret detail → 500, message hidden, logged', async () => {
  const res = await run(async () => { throw new Error('secret database detail: password=hunter2'); });
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(JSON.stringify(body)).not.toContain('hunter2');
  expect(body.error.message).toBe('Internal server error');
  expect(errSpy).toHaveBeenCalled();
});

it('7. ZodError → 400', async () => {
  const res = await run(async () => { z.object({ a: z.string() }).parse({}); return ok(null); });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
});

it('8. success response is passed through unchanged', async () => {
  const res = await run(async () => ok({ hello: 'world' }, 201));
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ ok: true, data: { hello: 'world' } });
  expect(errSpy).not.toHaveBeenCalled();
});
