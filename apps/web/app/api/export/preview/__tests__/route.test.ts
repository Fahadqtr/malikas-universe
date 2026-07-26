/**
 * Route tests for POST /api/export/preview — owner or editor (ROLE_SETS.writers).
 *
 * Reads products with the service-role client and builds an export preview, so
 * it must authorize BEFORE body parse, admin client, DB, or the preview
 * validator, and it must never leak raw DB/helper error text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, validateBatchMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  validateBatchMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/export-validator', () => ({ validateBatch: validateBatchMock }));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

/** Chainable admin mock: awaiting the query chain resolves the queued result. */
function makeAdmin(result: unknown) {
  const admin = {
    from() {
      const chain: unknown = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
          return () => chain;
        },
      });
      return chain;
    },
  };
  return admin;
}

function outcomeOk() {
  return {
    target: 'snoonu',
    total: 1,
    eligible_count: 1,
    blocked_count: 0,
    blocked: [],
    eligible: [
      { master_sku: 'S1', product_name_en: 'X', product_name_ar: 'Y', brand: { name: 'B' }, category: { name: 'C' }, price: 10, image_url: null },
    ],
  };
}
function req(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}
const validBody = { target: 'snoonu', master_skus: ['S1'] };

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('authorization', () => {
  it('unauthenticated → 401; requireActor(writers); no body read, no admin, no helper', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    const rq = req(validBody);
    const res = await POST(rq);
    expect(res.status).toBe(401);
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
    expect(validateBatchMock).not.toHaveBeenCalled();
  });

  it('viewer → 403; no body read, no admin, no helper (readers no longer allowed)', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    const rq = req(validBody);
    const res = await POST(rq);
    expect(res.status).toBe(403);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
    expect(validateBatchMock).not.toHaveBeenCalled();
  });
});

describe('happy path', () => {
  it.each([['owner'], ['editor']])('%s → 200; builds preview; response shape preserved', async (role) => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role });
    createAdminMock.mockReturnValue(makeAdmin({ data: [{ master_sku: 'S1' }], error: null }));
    validateBatchMock.mockReturnValue(outcomeOk());
    const res = await POST(req(validBody));
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ target: 'snoonu', total: 1, eligible_count: 1, blocked_count: 0, blocked: [] });
    expect(body.data.sample).toHaveLength(1);
    expect(body.data.sample[0]).toMatchObject({ master_sku: 'S1', brand: 'B', category: 'C' });
    expect(validateBatchMock).toHaveBeenCalled();
  });
});

describe('invocation order', () => {
  it('auth before body read, admin client, and preview validator', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin({ data: [], error: null }));
    validateBatchMock.mockReturnValue(outcomeOk());
    const rq = req(validBody);
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(validateBatchMock.mock.invocationCallOrder[0]!);
  });
});

describe('request validation (existing, owner)', () => {
  it('invalid target → 400; no admin client', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    const res = await POST(req({ target: 'not-a-platform' }));
    expect(res.status).toBe(400);
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('error hardening (owner)', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('DB list failure → 500 LIST_FAILED / "Export preview setup failed"; no raw; no preview built', async () => {
    createAdminMock.mockReturnValue(makeAdmin({ data: null, error: { message: 'permission denied for relation products' } }));
    const res = await POST(req(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('LIST_FAILED');
    expect(body.error.message).toBe('Export preview setup failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(validateBatchMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('preview/helper failure → 500 PREVIEW_FAILED / "Export preview failed"; no raw; logs real error', async () => {
    createAdminMock.mockReturnValue(makeAdmin({ data: [{ master_sku: 'S1' }], error: null }));
    validateBatchMock.mockImplementation(() => {
      throw new Error('export builder failed with internal column mapping secret');
    });
    const res = await POST(req(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('PREVIEW_FAILED');
    expect(body.error.message).toBe('Export preview failed');
    expect(JSON.stringify(body)).not.toContain('column mapping secret');
    expect(errSpy).toHaveBeenCalled();
  });
});
