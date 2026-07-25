/**
 * Route tests for POST /api/snoonu-fast-sync/apply-catalog-section — owner only.
 * OPTIONS stays public (CORS). Authorization + Supabase are mocked; no network.
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

import { POST, OPTIONS } from '../route';
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
const validBody = { section_name: 'Hair Care', source_url: 'https://x', pages_scanned: 1, products: [] };
beforeEach(() => vi.clearAllMocks());

it.each([
  ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
  ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
  ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
])('%s → %s; no body parse, no admin client', async (_l, thrown, status) => {
  const rq = reqWith(validBody);
  requireActorMock.mockRejectedValue(thrown);
  const res = await POST(rq);
  expect(res.status).toBe(status);
  expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
  expect(createAdminMock).not.toHaveBeenCalled();
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; applies one section', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: { id: 1 }, error: null }]));
    const res = await POST(reqWith(validBody));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
  });

  it('scrape insert DB error → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'violates constraint scrapes_pkey' } }]));
    const res = await POST(reqWith(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('SCRAPE_INSERT_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('scrapes_pkey');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: { id: 1 }, error: null }]));
    const rq = reqWith(validBody);
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});

describe('OPTIONS (public CORS)', () => {
  it('returns 204 without auth or admin client', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(requireActorMock).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});
