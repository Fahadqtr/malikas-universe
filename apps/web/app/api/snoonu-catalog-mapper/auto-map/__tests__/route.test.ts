/**
 * Route tests for POST /api/snoonu-catalog-mapper/auto-map — owner only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireActorMock, createAdminMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

function makeAdmin(results: unknown[]) {
  let i = 0;
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: [], error: null });
      return () => proxy;
    },
  });
  return proxy;
}
function reqWith(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}
beforeEach(() => vi.clearAllMocks());

it.each([
  ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
  ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
  ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
])('%s → %s; no body read, no admin client (no candidate read/write)', async (_l, thrown, status) => {
  const rq = reqWith({ import_id: 1 });
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST(rq);
  expect(res.status).toBe(status);
  expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; runs a mocked mapping (empty set)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    const res = await POST(reqWith({ import_id: 1 }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { scanned: 0, mapped: 0, still_missing: 0 } });
  });

  it('select failure → 500 generic (no raw SQL/provider message)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'permission denied platform_products' } }]));
    const res = await POST(reqWith({ import_id: 1 }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SELECT_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    const rq = reqWith({ import_id: 1 });
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
