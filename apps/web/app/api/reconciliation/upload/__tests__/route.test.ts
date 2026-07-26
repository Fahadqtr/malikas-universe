/**
 * Route tests for POST /api/reconciliation/upload — owner only.
 *
 * Accepts a multipart export, parses + normalizes, and bulk-inserts into the
 * live platform_products table with the service-role client, so it must be
 * gated to `owner` BEFORE formData, parsing, admin client, or DB work. It must
 * never leak raw parser/DB messages or the uploaded file's headers, and the
 * persisted error_message column must stay generic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  requireActorMock, createAdminMock, parseMock, normalizeRowsMock,
  normalizeNameMock, normalizeBrandMock, variantMock, categoryMock,
} = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  parseMock: vi.fn(),
  normalizeRowsMock: vi.fn(),
  normalizeNameMock: vi.fn(),
  normalizeBrandMock: vi.fn(),
  variantMock: vi.fn(),
  categoryMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@malikas/shared', () => ({ parseFile: parseMock }));
vi.mock('@/lib/reconciliation/normalizer', () => ({ normalizeRows: normalizeRowsMock }));
vi.mock('@/lib/reconciliation/text-normalizer', () => ({
  normalizeProductName: normalizeNameMock,
  normalizeBrand: normalizeBrandMock,
}));
vi.mock('@/lib/reconciliation/variant-extractor', () => ({ extractVariantAttrs: variantMock }));
vi.mock('@/lib/reconciliation/category-extractor', () => ({ extractCategory: categoryMock }));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

function makeAdmin(results: unknown[]) {
  let i = 0;
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const admin = {
    __inserts: inserts,
    __updates: updates,
    from(table: string) {
      const chain: unknown = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: [], error: null });
          return (...args: unknown[]) => {
            if (prop === 'insert') inserts.push({ table, payload: args[0] });
            if (prop === 'update') updates.push({ table, payload: args[0] });
            return chain;
          };
        },
      });
      return chain;
    },
  };
  return admin;
}

function fileReq(size?: number) {
  const fd = new FormData();
  fd.append('file', new Blob([size ? new Uint8Array(size) : new Uint8Array([1, 2, 3])]));
  return { formData: vi.fn().mockResolvedValue(fd) } as never;
}

function normRow(i: number, withKey = true) {
  return {
    source_row_index: i,
    source_product_id: null,
    source_url: null,
    source_sku: withKey ? `S${i}` : null,
    barcode: null,
    name_en: 'X',
    name_ar: null,
    brand: 'B',
    category: 'C',
    subcategory: null,
    product_type: null,
    price: 10,
    discount_price: null,
    currency: 'QAR',
    stock_quantity: 1,
    stock_status: null,
    platform_status: null,
    image_url: null,
    image_filename: null,
    description_en: null,
    description_ar: null,
    variants: null,
    raw: {},
  };
}
function normOk(rows: ReturnType<typeof normRow>[], platform = 'snoonu') {
  return {
    platform,
    platform_score: 1,
    rows,
    column_mapping: {},
    detected_headers: ['sku'],
    prefix_mapping: {},
    category_hint_headers: [],
    unmapped_headers: [],
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  variantMock.mockReturnValue({
    extracted_tokens: [], variant_color: null, variant_shade: null, variant_size: null,
    variant_volume_value: null, variant_volume_unit: null, variant_pack: null,
    variant_model: null, variant_type: null,
  });
  normalizeNameMock.mockReturnValue({ normalized_name: 'x', name_root: 'x', token_signature: 'x' });
  normalizeBrandMock.mockReturnValue('b');
  categoryMock.mockReturnValue({
    category_missing: false, raw_category: null, raw_subcategory: null,
    category_name: 'C', subcategory_name: null, category_confidence: 1, category_source: 'direct',
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('non-owner blocked before formData / parser / admin', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no formData, no parse, no normalize, no admin', async (_l, thrown, status) => {
    const rq = fileReq();
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(rq);
    expect(res.status).toBe(status);
    expect((rq as { formData: ReturnType<typeof vi.fn> }).formData).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
    expect(normalizeRowsMock).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'owner-uuid', email: 'o@x.com', role: 'owner' }));

  it('requireActor with ownerOnly; imports rows; keeps 10000 row cap and created_by=actor.id', async () => {
    parseMock.mockResolvedValue({ rows: [{ a: 1 }], headers: ['sku'], total_rows: 1 });
    normalizeRowsMock.mockReturnValue(normOk([normRow(0)]));
    const admin = makeAdmin([
      { data: { id: 7 }, error: null }, // platform_imports insert
      { data: [] },                     // cheapMatch sku lookup
      { error: null },                  // platform_products insert
      {},                               // finalize
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(fileReq());
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect((await res.json()).data.import_id).toBe(7);
    expect(parseMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ max_rows: 10000 }));
    const imp = admin.__inserts.find((x) => x.table === 'platform_imports');
    expect((imp!.payload as { created_by: string }).created_by).toBe('owner-uuid');
  });

  it('authorization runs before formData, parseFile, and admin client', async () => {
    parseMock.mockResolvedValue({ rows: [{ a: 1 }], headers: ['sku'], total_rows: 1 });
    normalizeRowsMock.mockReturnValue(normOk([normRow(0)]));
    createAdminMock.mockReturnValue(makeAdmin([{ data: { id: 7 } }, { data: [] }, { error: null }, {}]));
    const rq = fileReq();
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { formData: ReturnType<typeof vi.fn> }).formData.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(parseMock.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });

  it('oversized file → 400 FILE_TOO_LARGE; never parsed (5MB limit intact)', async () => {
    const res = await POST(fileReq(5 * 1024 * 1024 + 1));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('FILE_TOO_LARGE');
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('parser failure → 400 generic (no raw parser text); logs server-side', async () => {
    parseMock.mockRejectedValue(new Error('xlsx central directory corrupt'));
    const res = await POST(fileReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('PARSE_FAILED');
    expect(body.error.message).toBe('Invalid or unreadable file');
    expect(JSON.stringify(body)).not.toContain('central directory');
    expect(errSpy).toHaveBeenCalled();
  });

  it('unknown platform → 400 without echoing the uploaded file headers', async () => {
    parseMock.mockResolvedValue({ rows: [{ a: 1 }], headers: ['SecretHeaderXYZ'], total_rows: 1 });
    normalizeRowsMock.mockReturnValue(normOk([normRow(0)], 'other'));
    const res = await POST(fileReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('PLATFORM_UNKNOWN');
    expect(JSON.stringify(body)).not.toContain('SecretHeaderXYZ');
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('import record insert failure → 500 generic (no raw SQL); logs server-side', async () => {
    parseMock.mockResolvedValue({ rows: [{ a: 1 }], headers: ['sku'], total_rows: 1 });
    normalizeRowsMock.mockReturnValue(normOk([normRow(0)]));
    createAdminMock.mockReturnValue(makeAdmin([
      { data: null, error: { message: 'permission denied for table platform_imports' } },
    ]));
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('IMPORT_INSERT_FAILED');
    expect(body.error.message).toBe('Reconciliation upload failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(errSpy).toHaveBeenCalled();
  });

  it('bulk row insert failure → 500 generic; persisted error_message is generic, not raw SQL', async () => {
    parseMock.mockResolvedValue({ rows: [{ a: 1 }], headers: ['sku'], total_rows: 1 });
    normalizeRowsMock.mockReturnValue(normOk([normRow(0)]));
    const admin = makeAdmin([
      { data: { id: 7 }, error: null }, // import insert
      { data: [] },                     // cheapMatch
      { error: { message: 'violates fk platform_products_import_id_fkey' } }, // products insert fails
      {},                               // error-status update
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('PRODUCTS_INSERT_FAILED');
    expect(body.error.message).toBe('Reconciliation import failed');
    expect(JSON.stringify(body)).not.toContain('platform_products_import_id_fkey');
    // The persisted DB error_message column must be generic, never raw SQL.
    const upd = admin.__updates.find((u) => u.table === 'platform_imports' && (u.payload as { status?: string }).status === 'error');
    expect(upd).toBeDefined();
    expect((upd!.payload as { error_message: string }).error_message).toBe('Reconciliation import failed');
    expect(JSON.stringify(admin.__updates)).not.toContain('fkey');
    expect(errSpy).toHaveBeenCalled();
  });

  it('partial insert failure → 500 generic with safe inserted_so_far count', async () => {
    parseMock.mockResolvedValue({ rows: [{ a: 1 }], headers: ['sku'], total_rows: 1001 });
    // 1001 key-less rows → cheapMatch makes no DB call; inserts split into 1000 + 1.
    normalizeRowsMock.mockReturnValue(normOk(Array.from({ length: 1001 }, (_v, i) => normRow(i, false))));
    const admin = makeAdmin([
      { data: { id: 7 }, error: null }, // import insert
      { error: null },                  // chunk 0 (1000 rows) ok
      { error: { message: 'deadlock detected' } }, // chunk 1 (1 row) fails
      {},                               // error-status update
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('PRODUCTS_INSERT_FAILED');
    expect(body.error.message).toBe('Reconciliation import failed');
    expect(body.error.details.inserted_so_far).toBe(1000);
    expect(JSON.stringify(body)).not.toContain('deadlock');
    expect(errSpy).toHaveBeenCalled();
  });
});
