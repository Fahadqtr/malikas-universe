/**
 * Route tests for DELETE/POST /api/reconciliation/runs/[id]/purge — owner only.
 * Authorization and Supabase are mocked; no real network. The real
 * api-response is used so ServiceError → HTTP status mapping is exercised.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireActorMock, createAdminMock, createServerMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  createServerMock: vi.fn(),
}));

vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: createServerMock,
}));

import { DELETE, POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

/** Chainable Supabase stub: every method returns itself; awaiting yields the
 *  next configured result. Records method calls for assertions. */
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
const ctx = { params: { id: '5' } };

beforeEach(() => vi.clearAllMocks());

describe('purge — non-owner is blocked before any work', () => {
  it('401 when requireActor throws UNAUTHORIZED; no admin client, no body read', async () => {
    const rq = reqWith({ confirm: 'PURGE_RUN_5' });
    requireActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    const res = await DELETE(rq, ctx);
    expect(res.status).toBe(401);
    expect(createAdminMock).not.toHaveBeenCalled();
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
  });

  it.each(['editor', 'viewer'])('403 for %s; no admin client, no body read', async (role) => {
    const rq = reqWith({ confirm: 'PURGE_RUN_5' });
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', `Role ${role} not allowed`, 403));
    const res = await DELETE(rq, ctx);
    expect(res.status).toBe(403);
    expect(createAdminMock).not.toHaveBeenCalled();
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
  });
});

describe('purge — owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor is called with ownerOnly', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ count: 0 }, { error: null }, { error: null }]));
    await DELETE(reqWith({ confirm: 'PURGE_RUN_5' }), ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
  });

  it('wrong confirm → 400 and no admin client created (no delete)', async () => {
    const res = await DELETE(reqWith({ confirm: 'WRONG' }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('CONFIRM_REQUIRED');
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('correct confirm → deletes findings then run, returns count', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ count: 3 }, { error: null }, { error: null }]));
    const res = await DELETE(reqWith({ confirm: 'PURGE_RUN_5' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { run_id: 5, findings_deleted: 3 } });
  });

  it('findings delete failure → 500 with generic message (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ count: 1 }, { error: { message: 'duplicate key products_pkey' } }]));
    const res = await DELETE(reqWith({ confirm: 'PURGE_RUN_5' }), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('FINDINGS_DELETE_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('products_pkey');
  });

  it('authorization runs before body read and before admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ count: 0 }, { error: null }, { error: null }]));
    const rq = reqWith({ confirm: 'PURGE_RUN_5' });
    await DELETE(rq, ctx);
    const authOrder = requireActorMock.mock.invocationCallOrder[0]!;
    const jsonOrder = (rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!;
    const adminOrder = createAdminMock.mock.invocationCallOrder[0]!;
    expect(authOrder).toBeLessThan(jsonOrder);
    expect(authOrder).toBeLessThan(adminOrder);
  });
});

describe('purge — POST alias', () => {
  it('POST is the same protected handler as DELETE', () => {
    expect(POST).toBe(DELETE);
  });
});
