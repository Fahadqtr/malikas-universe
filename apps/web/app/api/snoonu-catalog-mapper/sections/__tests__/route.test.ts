/**
 * Route tests for /api/snoonu-catalog-mapper/sections.
 * DELETE — owner only. GET — read, authorization unchanged (NOT owner-gated).
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

import { GET, DELETE } from '../route';
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
function req(path: string) {
  return { url: `http://localhost${path}` } as never;
}
beforeEach(() => vi.clearAllMocks());

describe('DELETE — owner only', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no admin client (no delete)', async (_l, thrown, status) => {
    requireActorMock.mockRejectedValue(thrown);
    const res = await DELETE(req('/api/snoonu-catalog-mapper/sections?id=5'));
    expect(res.status).toBe(status);
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('owner deletes the section', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin([{ error: null }]));
    const res = await DELETE(req('/api/snoonu-catalog-mapper/sections?id=5'));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { deleted: 5 } });
  });

  it('delete failure → 500 generic (no raw SQL)', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin([{ error: { message: 'violates fk snoonu_catalog_sections' } }]));
    const res = await DELETE(req('/api/snoonu-catalog-mapper/sections?id=5'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DELETE_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('snoonu_catalog_sections');
  });

  it('authorization runs before the admin client', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin([{ error: null }]));
    await DELETE(req('/api/snoonu-catalog-mapper/sections?id=5'));
    expect(requireActorMock.mock.invocationCallOrder[0]!).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});

describe('GET — authorization unchanged (not owner-gated)', () => {
  it('does not call requireActor and returns data', async () => {
    // Even if requireActor WOULD reject, GET must not invoke it (unchanged behavior).
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    createAdminMock.mockReturnValue(makeAdmin([{ data: [{ id: 1, catalog_name_en: 'Hair Care' }] }]));
    const res = await GET(req('/api/snoonu-catalog-mapper/sections?limit=10'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.sections).toHaveLength(1);
    expect(requireActorMock).not.toHaveBeenCalled();
  });
});
