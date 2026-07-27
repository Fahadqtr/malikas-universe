/**
 * Route tests for POST /api/snoonu-browser-audit/save-from-browser — owner only.
 *
 * This endpoint can auto-apply a browser snapshot to the LIVE catalog
 * (platform_products: price/stock/name/category/image) with the service-role
 * client, so it must be gated to `owner` BEFORE body parse, admin client, DB,
 * or any catalog write, and it must never leak raw DB error text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, extractMock, usableMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  extractMock: vi.fn(),
  usableMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/reconciliation/snoonu-browser-extractor', () => ({
  extractProductData: extractMock,
  snapshotIsUsable: usableMock,
}));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

/** Admin mock: FIFO results; records update/insert writes with their table + payload. */
function makeAdmin(results: unknown[]) {
  let i = 0;
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const admin = {
    __writes: writes,
    from(table: string) {
      let op: string | null = null;
      let payload: unknown = null;
      const chain: unknown = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              if (op) writes.push({ table, op, payload });
              resolve(results[i++] ?? { data: null, error: null });
            };
          }
          return (...args: unknown[]) => {
            if (prop === 'update') { op = 'update'; payload = args[0]; }
            if (prop === 'insert') { op = 'insert'; payload = args[0]; }
            return chain;
          };
        },
      });
      return chain;
    },
  };
  return admin;
}

function extracted(overrides: Record<string, unknown> = {}) {
  return {
    confidence: 0.5,
    snoonu_product_url: null, snoonu_product_id: null,
    snoonu_product_name: 'Widget', snoonu_name_ar: null,
    snoonu_catalog: null, snoonu_category: null, snoonu_subcategory: null,
    snoonu_section: null, snoonu_menu_path: null, snoonu_secondary_categories: [],
    snoonu_price: null, snoonu_discount_price: null, snoonu_currency: null,
    snoonu_stock: null, snoonu_status: null, snoonu_is_visible: null,
    snoonu_image_url: null, snoonu_image_filename: null,
    branches: [], has_options: false, option_groups: [], variants: [],
    ...overrides,
  };
}
function product(overrides: Record<string, unknown> = {}) {
  return { id: 5, import_id: 2, platform: 'snoonu', source_sku: 'S', name_en: 'Widget', name_ar: null, normalized_name: 'widget', price: 10, ...overrides };
}
function req(body: unknown = { product_id: 5, queue_product_name: 'Widget', snapshot: { any: true } }) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  usableMock.mockReturnValue(true);
  extractMock.mockReturnValue(extracted());
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('authorization', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
  ])('%s → %s; no body read, no admin, no DB, no extract', async (_l, thrown, status) => {
    requireActorMock.mockRejectedValue(thrown);
    const rq = req();
    const res = await POST(rq);
    expect(res.status).toBe(status);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect((rq as { json: ReturnType<typeof vi.fn> }).json).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
    expect(usableMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'owner-uuid', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; new audit saved with audited_by=actor.id; not auto-applied at low confidence', async () => {
    extractMock.mockReturnValue(extracted({ confidence: 0.5, snoonu_product_name: 'Widget' })); // finalConfidence ~0.65
    const admin = makeAdmin([
      { data: product() },   // product lookup
      { data: null },        // existing audit lookup → none
      { data: { id: 99 }, error: null }, // insert audit
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req());
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ audit_id: 99, auto_applied: false });
    const ins = admin.__writes.find((w) => w.table === 'snoonu_browser_audits' && w.op === 'insert');
    expect((ins!.payload as { audited_by: string }).audited_by).toBe('owner-uuid');
    // No live-catalog write at low confidence.
    expect(admin.__writes.some((w) => w.table === 'platform_products')).toBe(false);
  });

  it('auto-apply (confidence≥0.95) writes live platform_products; payload preserved', async () => {
    extractMock.mockReturnValue(extracted({
      confidence: 1, snoonu_product_name: 'Widget', snoonu_category: 'Cat',
      snoonu_price: 12, snoonu_stock: 3, snoonu_status: 'active',
    }));
    const admin = makeAdmin([
      { data: product() },              // product lookup
      { data: null },                   // existing → none
      { data: { id: 99 }, error: null }, // insert audit
      {},                               // platform_products update (auto-apply)
      {},                               // browser_audits verified update
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ auto_applied: true, audit_status: 'verified' });
    const pp = admin.__writes.find((w) => w.table === 'platform_products' && w.op === 'update');
    expect(pp).toBeDefined();
    expect(pp!.payload).toMatchObject({
      catalog_source: 'browser_read', price: 12, stock_quantity: 3,
      name_en: 'Widget', snoonu_category: 'Cat', platform_status: 'active',
    });
  });

  it('authorization runs before body read and admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: product() }, { data: null }, { data: { id: 1 }, error: null }]));
    const rq = req();
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { json: ReturnType<typeof vi.fn> }).json.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });

  it('update failure → 500 AUDIT_UPDATE_FAILED / generic; no raw; no live-catalog write', async () => {
    const admin = makeAdmin([
      { data: product() },                 // product lookup
      { data: { id: 42 } },                // existing audit → update path
      { error: { message: 'duplicate key snoonu_browser_audits_pkey' } }, // update fails
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.error.code).toBe('AUDIT_UPDATE_FAILED');
    expect(b.error.message).toBe('Browser audit save failed');
    expect(JSON.stringify(b)).not.toContain('snoonu_browser_audits_pkey');
    expect(admin.__writes.some((w) => w.table === 'platform_products')).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });

  it('insert failure → 500 AUDIT_INSERT_FAILED / generic; no raw; logs real error', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: product() },
      { data: null },
      { data: null, error: { message: 'null value violates snoonu_browser_audits' } },
    ]));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.error.code).toBe('AUDIT_INSERT_FAILED');
    expect(b.error.message).toBe('Browser audit save failed');
    expect(JSON.stringify(b)).not.toContain('null value violates');
    expect(errSpy).toHaveBeenCalled();
  });

  it('existing validation preserved: empty snapshot → 400 SNAPSHOT_EMPTY, no admin', async () => {
    usableMock.mockReturnValue(false);
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('SNAPSHOT_EMPTY');
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('existing validation preserved: product not found → 404 PRODUCT_NOT_FOUND', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null }])); // product lookup → none
    const res = await POST(req());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('catalog auto-apply failure → 500 AUDIT_APPLY_FAILED; no raw; audit NOT marked verified', async () => {
    extractMock.mockReturnValue(extracted({ confidence: 1, snoonu_product_name: 'Widget', snoonu_price: 12 }));
    const admin = makeAdmin([
      { data: product() },                 // product lookup
      { data: null },                      // existing → none
      { data: { id: 99 }, error: null },   // insert audit
      { error: { message: 'permission denied for relation platform_products' } }, // catalog update fails
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.error.code).toBe('AUDIT_APPLY_FAILED');
    expect(b.error.message).toBe('Browser audit apply failed');
    expect(JSON.stringify(b)).not.toContain('permission denied');
    // Catalog update was attempted, but the audit row must NOT be flipped to verified.
    expect(admin.__writes.some((w) => w.table === 'platform_products' && w.op === 'update')).toBe(true);
    expect(admin.__writes.filter((w) => w.table === 'snoonu_browser_audits' && w.op === 'update')).toHaveLength(0);
    expect(errSpy).toHaveBeenCalled();
  });

  it('audit verification failure → 500 AUDIT_VERIFY_FAILED; no raw; catalog already applied (no rollback)', async () => {
    extractMock.mockReturnValue(extracted({ confidence: 1, snoonu_product_name: 'Widget', snoonu_price: 12 }));
    const admin = makeAdmin([
      { data: product() },                 // product lookup
      { data: null },                      // existing → none
      { data: { id: 99 }, error: null },   // insert audit
      {},                                  // catalog update OK
      { error: { message: 'audit status check constraint violation' } }, // verify update fails
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req());
    expect(res.status).toBe(500);
    const b = await res.json();
    expect(b.error.code).toBe('AUDIT_VERIFY_FAILED');
    expect(b.error.message).toBe('Browser audit apply failed');
    expect(JSON.stringify(b)).not.toContain('constraint violation');
    // Catalog was updated before the failing verify step; no rollback is attempted.
    expect(admin.__writes.some((w) => w.table === 'platform_products' && w.op === 'update')).toBe(true);
    expect(admin.__writes.some((w) => w.table === 'snoonu_browser_audits' && w.op === 'update')).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});
