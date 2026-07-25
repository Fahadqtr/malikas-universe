/**
 * Route tests for POST /api/snoonu-fast-sync/rebuild-audit-queue-v2 — owner only.
 * PRESERVED DIFFERENCE vs v1: v2 does NOT call the enqueue_snoonu_audits RPC;
 * it builds the queue from Fast-Sync rows directly.
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
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null, count: 0 });
      if (prop === '__calls') return calls;
      return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return proxy; };
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
])('%s → %s; no admin client', async (_l, thrown, status) => {
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST(reqWith({}));
  expect(res.status).toBe(status);
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; runs and does NOT call enqueue RPC (v1/v2 difference)', async () => {
    const admin = makeAdmin([{ data: { id: 5 }, error: null }]); // latest import resolves to id 5
    createAdminMock.mockReturnValue(admin);
    const res = await POST(reqWith({}));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    const calls = (admin as { __calls: Array<{ method: string; args: unknown[] }> }).__calls;
    const enqueue = calls.find((c) => c.method === 'rpc' && c.args[0] === 'enqueue_snoonu_audits');
    expect(enqueue).toBeUndefined();
  });

  it('authorization runs before admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: { id: 5 }, error: null }]));
    await POST(reqWith({}));
    expect(requireActorMock.mock.invocationCallOrder[0]!).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
