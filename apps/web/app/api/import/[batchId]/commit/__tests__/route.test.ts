/**
 * Route tests for POST /api/import/[batchId]/commit — owner only.
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
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null });
      return () => proxy;
    },
  });
  return proxy;
}
function reqWith(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}
const ctx = { params: { batchId: '42' } };
beforeEach(() => vi.clearAllMocks());

describe('commit — non-owner blocked before body read / admin client', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no body parse, no admin client', async (_label, thrown, status) => {
    const rq = reqWith({ row_ids: [1] });
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(rq, ctx);
    expect(res.status).toBe(status);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('commit — owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    await POST(reqWith({}), ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
  });

  it('no committable rows → NOTHING_TO_COMMIT 400 (current behavior)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    const res = await POST(reqWith({}), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NOTHING_TO_COMMIT');
  });

  it('staged row → inserts product and updates batch', async () => {
    const stagedRow = {
      id: 1, error_type: 'auto_import', row_number: 1,
      raw_data: { cleaned: { product_name_en: 'Widget' }, category: { category_id: 2 } },
    };
    createAdminMock.mockReturnValue(makeAdmin([
      { data: [stagedRow], error: null },     // select import_errors
      { data: { master_sku: 'M1' }, error: null }, // insert product .single()
      { data: null, error: null },            // batch update
    ]));
    const res = await POST(reqWith({ row_ids: [1] }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.batch_id).toBe(42);
    expect(body.data.inserted).toBe(1);
  });

  it('per-row insert error is NOT leaked in the 200 response; logged server-side', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stagedRow = {
      id: 1, error_type: 'auto_import', row_number: 3,
      raw_data: { cleaned: { product_name_en: 'Widget', barcode: '123' }, category: { category_id: 2 } },
    };
    const sensitive = 'duplicate key value violates unique constraint products_barcode_key';
    createAdminMock.mockReturnValue(makeAdmin([
      { data: [stagedRow], error: null },              // select import_errors
      { data: null, error: { message: sensitive } },   // insert product .single() FAILS
      { data: null, error: null },                     // batch update
    ]));
    const res = await POST(reqWith({ row_ids: [1] }), ctx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.inserted).toBe(0);
    expect(body.data.failed).toBe(1);
    expect(body.data.details.failed[0].reason).toBe('Product insert failed');
    expect(body.data.details.failed[0].raw_index).toBe(3);
    // The sensitive SQL must not appear anywhere in the client response.
    expect(JSON.stringify(body)).not.toContain('products_barcode_key');
    expect(JSON.stringify(body)).not.toContain('duplicate key');
    // Logged server-side, but the staged row / raw_data must not be logged.
    expect(errSpy).toHaveBeenCalled();
    const loggedText = JSON.stringify(errSpy.mock.calls);
    expect(loggedText).not.toContain('raw_data');
    expect(loggedText).not.toContain('Widget');
    errSpy.mockRestore();
  });

  it('staged-rows load failure → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'column raw_data does not exist' } }]));
    const res = await POST(reqWith({}), ctx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('raw_data does not exist');
  });

  it('authorization runs before body read and before admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: [], error: null }]));
    const rq = reqWith({});
    await POST(rq, ctx);
    const authOrder = requireActorMock.mock.invocationCallOrder[0]!;
    const jsonOrder = (rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!;
    const adminOrder = createAdminMock.mock.invocationCallOrder[0]!;
    expect(authOrder).toBeLessThan(jsonOrder);
    expect(authOrder).toBeLessThan(adminOrder);
  });
});
