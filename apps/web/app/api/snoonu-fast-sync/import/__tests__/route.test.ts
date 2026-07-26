/**
 * Route tests for POST /api/snoonu-fast-sync/import — owner only.
 *
 * This endpoint parses an uploaded Snoonu xlsx and UPSERTs into
 * platform_products with the service-role client, so it must be gated to
 * `owner` BEFORE any formData/file read, xlsx parse, admin client, or DB write,
 * and it must never leak raw DB/provider messages (in the response or in the
 * snoonu_fast_sync_runs.error_message column).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, parseMock, validateRowMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  parseMock: vi.fn(),
  validateRowMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/reconciliation/snoonu-export-importer', () => ({
  parseSnoonuExportBuffer: parseMock,
  validateRow: validateRowMock,
}));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

/**
 * Chainable admin mock: any method returns the chain; awaiting resolves the
 * next queued result (FIFO). Records every .update()/.insert() payload with its
 * table so tests can assert what was written.
 */
function makeAdmin(results: unknown[]) {
  let i = 0;
  const updates: Array<{ table: string; payload: unknown }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const admin = {
    __updates: updates,
    __inserts: inserts,
    from(table: string) {
      const chain: unknown = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null });
          return (...args: unknown[]) => {
            if (prop === 'update') updates.push({ table, payload: args[0] });
            if (prop === 'insert') inserts.push({ table, payload: args[0] });
            return chain;
          };
        },
      });
      return chain;
    },
  };
  return admin;
}

const sampleRow = {
  spi: 'SPI-1',
  row_index: 2,
  name_en: 'Prod',
  name_ar: 'برود',
  description_en: 'd',
  description_ar: 'دي',
  price_ali: 10,
  price_aziziyah: null,
  stock_ali: 5,
  stock_aziziyah: null,
  available_ali: true,
  available_aziziyah: null,
  derived: {
    price: 10,
    stock_quantity: 5,
    platform_status: 'active',
    snoonu_branches: [],
    normalized_name: 'prod',
  },
};

function parsedOneRow() {
  return { total_rows: 1, rows: [sampleRow], warnings: [] };
}

/** Build a NextRequest-ish object with a real multipart FormData. */
function fileReq() {
  const form = new FormData();
  form.append('file', new Blob(['xlsx-bytes']));
  return { formData: vi.fn().mockResolvedValue(form) } as never;
}

// The happy-path DB queue: platform_imports insert, runs insert, load existing,
// products insert, finalize run, finalize import.
function happyResults() {
  return [
    { data: { id: 1 }, error: null }, // platform_imports insert .single()
    { data: { id: 2 }, error: null }, // snoonu_fast_sync_runs insert .single()
    { data: [], error: null },        // load existing platform_products
    { error: null },                  // products insert chunk
    {},                               // finalize run update
    {},                               // finalize import update
  ];
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  validateRowMock.mockReturnValue(null); // rows valid by default
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('non-owner blocked before formData / parse / admin', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no file read, no parse, no admin client', async (_l, thrown, status) => {
    const rq = fileReq();
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(rq);
    expect(res.status).toBe(status);
    expect((rq as { formData: ReturnType<typeof vi.fn> }).formData).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; imports one row (business logic preserved)', async () => {
    parseMock.mockReturnValue(parsedOneRow());
    createAdminMock.mockReturnValue(makeAdmin(happyResults()));
    const res = await POST(fileReq());
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.total_rows).toBe(1);
    expect(body.data.inserted).toBe(1);
  });

  it('authorization runs before formData, xlsx parse, and admin client', async () => {
    parseMock.mockReturnValue(parsedOneRow());
    createAdminMock.mockReturnValue(makeAdmin(happyResults()));
    const rq = fileReq();
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { formData: ReturnType<typeof vi.fn> }).formData.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(parseMock.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });

  it('parse failure → 400 generic (no raw parser message); logs server-side', async () => {
    parseMock.mockImplementation(() => {
      throw new Error('SheetJS: corrupt zip central directory');
    });
    const res = await POST(fileReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('PARSE_FAILED');
    expect(body.error.message).toBe('Invalid or unreadable file');
    expect(JSON.stringify(body)).not.toContain('SheetJS');
    expect(errSpy).toHaveBeenCalled();
  });

  it('load-existing failure → 500 generic (no raw SQL); logs server-side', async () => {
    parseMock.mockReturnValue(parsedOneRow());
    createAdminMock.mockReturnValue(makeAdmin([
      { data: { id: 1 }, error: null },
      { data: { id: 2 }, error: null },
      { data: null, error: { message: 'permission denied for table platform_products' } },
    ]));
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('LOAD_EXISTING_FAILED');
    expect(body.error.message).toBe('Import failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(errSpy).toHaveBeenCalled();
  });

  it('insert failure → 500 generic; error_message column is generic, not raw SQL', async () => {
    parseMock.mockReturnValue(parsedOneRow());
    const admin = makeAdmin([
      { data: { id: 1 }, error: null },
      { data: { id: 2 }, error: null },
      { data: [], error: null },
      { error: { message: 'duplicate key value violates products_pkey' } }, // insert fails
      {}, // run update → error
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INSERT_FAILED');
    expect(body.error.message).toBe('Product import failed');
    expect(JSON.stringify(body)).not.toContain('products_pkey');
    // The persisted run error_message must be generic, never the raw DB message.
    const runUpdate = admin.__updates.find(
      (u) => u.table === 'snoonu_fast_sync_runs' && (u.payload as { status?: string }).status === 'error',
    );
    expect(runUpdate).toBeDefined();
    expect((runUpdate!.payload as { error_message: string }).error_message).toBe('Product import failed');
    expect(JSON.stringify(admin.__updates)).not.toContain('products_pkey');
    expect(errSpy).toHaveBeenCalled();
  });
});
