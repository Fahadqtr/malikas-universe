/**
 * Route tests for POST /api/snoonu-fast-sync/quick-pass-fixes — owner only.
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
])('%s → %s; no admin client / no update', async (_l, thrown, status) => {
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST(reqWith({ dry_run: true }));
  expect(res.status).toBe(status);
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; dry_run reaches logic', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    const res = await POST(reqWith({ dry_run: true }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
  });

  it('load failure → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'relation platform_products missing' } }]));
    const res = await POST(reqWith({ dry_run: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('LOAD_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('platform_products missing');
  });

  it('per-update failure uses a generic reason in write_errors[] (no SQL)', async () => {
    // First page returns one Rhode row (fires brand_priority rule); the update fails.
    createAdminMock.mockReturnValue(makeAdmin([
      { data: [{ id: 1, name_en: 'Rhode Serum', snoonu_category: 'Masks', catalog_source: null, catalog_confidence: null }], error: null },
      { error: { message: 'duplicate key products_pkey' } }, // the .update().in()
    ]));
    const res = await POST(reqWith({ dry_run: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.write_errors).toEqual(['Update failed']);
    expect(JSON.stringify(body)).not.toContain('products_pkey');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    const rq = reqWith({ dry_run: true });
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
