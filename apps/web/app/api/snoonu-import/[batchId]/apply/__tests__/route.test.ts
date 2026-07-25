/**
 * Route tests for POST /api/snoonu-import/[batchId]/apply — owner only.
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
function reqWith(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}
const ctx = { params: { batchId: '5' } };
beforeEach(() => vi.clearAllMocks());

describe('non-owner blocked before batchId parse / body / admin', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no body read, no admin client', async (_l, thrown, status) => {
    const rq = reqWith({ dry_run: true });
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(rq, ctx);
    expect(res.status).toBe(status);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'owner-uuid', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; dry-run with no reviewed items', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [] }])); // items select empty
    const res = await POST(reqWith({ dry_run: true }), ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ applied: 0, skipped: 0, failed: 0 });
  });

  it('per-row insert failure → generic reason in errors[], counts preserved, no raw SQL', async () => {
    const item = {
      id: 1, review_action: 'create_new', generated_sku: 'SKU1',
      extracted_name_en: 'X', extracted_name_ar: 'Y', extracted_brand: 'BrandA',
      extracted_price: 10, extracted_discount_price: null,
      source_url: 'https://s', source_image_url: null, imported_image_url: null,
      image_filename: null, image_storage_path: null, matched_product_sku: null,
      raw_payload: { overrides: { main_category: 'TestCat' } },
    };
    createAdminMock.mockReturnValue(makeAdmin([
      {},                                     // batch → 'applying'
      { data: [item] },                       // items select
      { data: [{ id: 5, name: 'BrandA' }] },  // brands lookup
      { data: [{ id: 9, name: 'TestCat' }] }, // categories lookup
      { error: { message: 'duplicate key value violates products_pkey' } }, // product insert
      {},                                     // batch finalize
    ]));
    const res = await POST(reqWith({ dry_run: false }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.failed).toBe(1);
    expect(body.data.errors[0]).toEqual({ item_id: 1, reason: 'Import apply failed' });
    expect(JSON.stringify(body)).not.toContain('products_pkey');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [] }]));
    const rq = reqWith({ dry_run: true });
    await POST(rq, ctx);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
