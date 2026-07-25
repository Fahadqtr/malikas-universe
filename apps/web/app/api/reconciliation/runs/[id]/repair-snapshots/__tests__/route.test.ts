/**
 * Route tests for POST /api/reconciliation/runs/[id]/repair-snapshots — owner only.
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
const ctx = { params: { id: '7' } };
beforeEach(() => vi.clearAllMocks());

it.each([
  ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
  ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
  ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
])('%s → %s and no admin client / no select', async (_label, thrown, status) => {
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST({} as never, ctx);
  expect(res.status).toBe(status);
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor is called with ownerOnly', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    await POST({} as never, ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
  });

  it('runs the (mocked) repair path and returns success', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }])); // empty first page → loop breaks
    const res = await POST({} as never, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.run_id).toBe(7);
    expect(body.data.repaired).toBe(0);
  });

  it('select failure → 500 generic (no raw SQL leaked)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'relation reconciliation_findings missing' } }]));
    const res = await POST({} as never, ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SELECT_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('reconciliation_findings missing');
  });

  it('authorization runs before the admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    await POST({} as never, ctx);
    expect(requireActorMock.mock.invocationCallOrder[0]!).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
