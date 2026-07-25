/**
 * Route tests for POST /api/snoonu-fast-sync/rebuild-audit-queue — owner only.
 * v1 DOES call the enqueue_snoonu_audits RPC (the key difference vs v2).
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
])('%s → %s; no admin client and no enqueue RPC', async (_l, thrown, status) => {
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST(reqWith({ import_id: 5 }));
  expect(res.status).toBe(status);
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; calls enqueue_snoonu_audits RPC', async () => {
    const admin = makeAdmin([]); // all awaited calls return benign defaults
    createAdminMock.mockReturnValue(admin);
    const res = await POST(reqWith({ import_id: 5 }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    const rpcCall = (admin as { __calls: Array<{ method: string; args: unknown[] }> }).__calls
      .find((c) => c.method === 'rpc');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.args[0]).toBe('enqueue_snoonu_audits');
  });

  it('authorization runs before body read, admin client, and RPC', async () => {
    createAdminMock.mockReturnValue(makeAdmin([]));
    const rq = reqWith({ import_id: 5 });
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
