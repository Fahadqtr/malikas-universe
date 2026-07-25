/**
 * Route tests for POST /api/snoonu-import/[batchId]/bulk-action — owner only.
 * Covers all action types; verifies reviewed_by comes from the actor (server),
 * not client input, and that DB errors are not leaked.
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
const ctx = { params: { batchId: '42' } };
beforeEach(() => vi.clearAllMocks());

describe('non-owner blocked before batchId parse / body / admin', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no body parse, no admin client', async (_l, thrown, status) => {
    const rq = reqWith({ item_ids: [1], action: 'create_new' });
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(rq, ctx);
    expect(res.status).toBe(status);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'owner-uuid', email: 'o@x.com', role: 'owner' }));

  it.each(['create_new', 'skip', 'needs_manual'])('straight action %s updates targeted items', async (action) => {
    const admin = makeAdmin([{ error: null }]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(reqWith({ item_ids: [1, 2], action }), ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { updated: 2, skipped: 0 } });
    // reviewed_by is set from the actor, never from client input.
    const upd = (admin as { __calls: Array<{ method: string; args: unknown[] }> }).__calls.find((c) => c.method === 'update');
    expect((upd!.args[0] as Record<string, unknown>).reviewed_by).toBe('owner-uuid');
  });

  it('update_existing only updates items with a matched sku', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: [{ id: 1, matched_product_sku: 'SKU1' }], error: null }, // select matched
      { error: null }, // update
    ]));
    const res = await POST(reqWith({ item_ids: [1], action: 'update_existing' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { updated: 1, skipped: 0 } });
  });

  it('update failure → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ error: { message: 'deadlock detected on snoonu_import_items' } }]));
    const res = await POST(reqWith({ item_ids: [1], action: 'create_new' }), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('UPDATE_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('deadlock detected');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ error: null }]));
    const rq = reqWith({ item_ids: [1], action: 'create_new' });
    await POST(rq, ctx);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
