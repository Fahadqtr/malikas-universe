/**
 * Route tests for POST /api/import/[batchId]/rollback — owner only.
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
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null });
      if (prop === '__calls') return calls;
      return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return proxy; };
    },
  });
  return proxy;
}
const ctx = { params: { batchId: '42' } };
beforeEach(() => vi.clearAllMocks());

it.each([
  ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
  ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
  ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
])('%s → %s and no admin client (no soft delete)', async (_label, thrown, status) => {
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST({} as never, ctx);
  expect(res.status).toBe(status);
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; soft-deletes products then updates batch', async () => {
    const admin = makeAdmin([{ data: [{ master_sku: 'A' }, { master_sku: 'B' }], error: null }, { data: null, error: null }]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST({} as never, ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { batch_id: 42, rolled_back_count: 2 } });
  });

  it('soft-delete payload is unchanged (deleted_at + archived + rollback tag)', async () => {
    const admin = makeAdmin([{ data: [], error: null }, { data: null, error: null }]);
    createAdminMock.mockReturnValue(admin);
    await POST({} as never, ctx);
    const updateCall = (admin as { __calls: Array<{ method: string; args: unknown[] }> }).__calls
      .find((c) => c.method === 'update');
    expect(updateCall).toBeDefined();
    const payload = updateCall!.args[0] as Record<string, unknown>;
    expect(payload.product_status).toBe('archived');
    expect(payload.updated_by).toBe('rollback:42');
    expect(typeof payload.deleted_at).toBe('string');
  });

  it('product update failure → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'permission denied for table products' } }]));
    const res = await POST({} as never, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('authorization runs before the admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }, { data: null, error: null }]));
    await POST({} as never, ctx);
    expect(requireActorMock.mock.invocationCallOrder[0]!).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
