/**
 * Route tests for POST /api/snoonu-browser-audit/apply — owner only.
 * The "action types" are the field selections; all go through the one POST.
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
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null });
      if (prop === '__calls') return calls;
      return (...args: unknown[]) => { calls.push({ method: String(prop), args }); return proxy; };
    },
  });
  return proxy;
}
function reqWith(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}
function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, product_id: 100, audit_status: 'pending',
    snoonu_product_url: null, snoonu_product_id: null,
    snoonu_product_name: 'Widget', snoonu_name_ar: null,
    snoonu_catalog: 'Cat', snoonu_category: 'Hair Care', snoonu_subcategory: null,
    snoonu_section: null, snoonu_menu_path: null,
    snoonu_price: 10, snoonu_discount_price: null, snoonu_stock: 5,
    snoonu_status: 'active', snoonu_image_url: null, snoonu_image_filename: null,
    has_options: false, option_groups: null, variants: null,
    snoonu_branches: null, snoonu_secondary_categories: null, ...overrides,
  };
}
beforeEach(() => vi.clearAllMocks());

describe('non-owner blocked before any work', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no body read, no admin client (no audit/product change)', async (_l, thrown, status) => {
    const rq = reqWith({ audit_id: 7, fields: ['all'] });
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(rq);
    expect(res.status).toBe(status);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'owner-uuid', email: 'o@x.com', role: 'owner' }));

  it.each([['catalog'], ['price'], ['all']])('applies fields=%j and updates audit status', async (field) => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: auditRow(), error: null }, // select audit
      { error: null },                   // product update
      { error: null },                   // audit update
    ]));
    const res = await POST(reqWith({ audit_id: 7, fields: [field] }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.audit_id).toBe(7);
    expect(body.data.audit_status).toBe('applied');
  });

  it('mark_verified sets verified_by from the actor (not client input)', async () => {
    const admin = makeAdmin([{ data: auditRow(), error: null }, { error: null }, { error: null }]);
    createAdminMock.mockReturnValue(admin);
    await POST(reqWith({ audit_id: 7, fields: ['catalog'], mark_verified: true }));
    const auditUpdate = (admin as { __calls: Array<{ method: string; args: unknown[] }> }).__calls
      .filter((c) => c.method === 'update')
      .map((c) => c.args[0] as Record<string, unknown>)
      .find((p) => 'verified_by' in p);
    expect(auditUpdate?.verified_by).toBe('owner-uuid');
  });

  it('product update failure → 500 generic (no raw SQL)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: auditRow(), error: null },
      { error: { message: 'violates fk platform_products_id' } },
    ]));
    const res = await POST(reqWith({ audit_id: 7, fields: ['catalog'] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('PRODUCT_UPDATE_FAILED');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('platform_products_id');
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: auditRow(), error: null }, { error: null }, { error: null }]));
    const rq = reqWith({ audit_id: 7, fields: ['catalog'] });
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});
