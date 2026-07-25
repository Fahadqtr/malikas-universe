/**
 * Route tests for POST /api/snoonu-catalog-mapper/set — owner only.
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
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null, count: 0 });
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
])('%s → %s; no body read, no admin client (no mapping write)', async (_l, thrown, status) => {
  const rq = reqWith({ row_id: 1, mapping: { snoonu_category: 'Cat' } });
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST(rq);
  expect(res.status).toBe(status);
  expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; saves mapping (payload preserved)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ error: null, count: 1 }]));
    const res = await POST(reqWith({ row_id: 1, mapping: { snoonu_category: 'Cat' } }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.updated).toBe(1);
    expect(body.data.applied.snoonu_category).toBe('Cat');
  });

  it('update failure → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ error: { message: 'permission denied platform_products' }, count: null }]));
    const res = await POST(reqWith({ row_id: 1, mapping: { snoonu_category: 'Cat' } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('UPDATE_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ error: null, count: 1 }]));
    const rq = reqWith({ row_id: 1, mapping: { snoonu_category: 'Cat' } });
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
