/**
 * Route tests for POST /api/import/upload — owner only.
 *
 * Accepts a multipart file, parses it, runs the orchestrator, and stages rows
 * with the service-role client, so it must be gated to `owner` BEFORE formData,
 * file parsing, admin client, or any DB work, and it must never leak raw
 * DB/parser messages. The staged-rows insert must no longer be silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, parseMock, detectMock, orchestrateMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  parseMock: vi.fn(),
  detectMock: vi.fn(),
  orchestrateMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@malikas/shared', () => ({
  parseFile: parseMock,
  detectPlatform: detectMock,
  orchestrate: orchestrateMock,
}));

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

/** Multipart request with a real FormData file. `size` overrides the byte count. */
function fileReq(size?: number) {
  const fd = new FormData();
  fd.append('file', new Blob([size ? new Uint8Array(size) : new Uint8Array([1, 2, 3])]));
  return { formData: vi.fn().mockResolvedValue(fd) } as never;
}

function parsedOk() {
  return { rows: [{ a: '1' }], headers: ['a'], total_rows: 1 };
}
function previewOk() {
  return {
    summary: { auto_import: 1, blocked: 0 },
    staged: [{ raw_index: 0, decision: 'import', decision_reason: 'ok' }],
  };
}
// brands, category_rules, keyword_rules, categories, products, batch insert, staged insert
function happyResults() {
  return [
    { data: [], error: null }, // brands
    { data: [] },              // category_rules
    { data: [] },              // keyword_rules
    { data: [] },              // categories
    { data: [] },              // products (barcodes)
    { data: { id: 42 }, error: null }, // import_batches insert
    { error: null },           // import_errors staged insert
  ];
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  detectMock.mockReturnValue({ platform: 'snoonu', mapping: {} });
  orchestrateMock.mockReturnValue(previewOk());
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('non-owner blocked before formData / parser / admin', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no formData, no parse, no admin', async (_l, thrown, status) => {
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
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'owner-uuid', email: 'o@x.com', role: 'owner' }));

  it('requireActor with ownerOnly; stages rows; keeps 5000 row cap and initiated_by=actor.email', async () => {
    parseMock.mockResolvedValue(parsedOk());
    const admin = makeAdmin(happyResults());
    createAdminMock.mockReturnValue(admin);
    const res = await POST(fileReq());
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect((await res.json()).data.batch_id).toBe(42);
    // Row cap preserved.
    expect(parseMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ max_rows: 5000 }));
    // Uses the central actor identity, not a second auth path.
    const batchInsert = admin.__inserts.find((x) => x.table === 'import_batches');
    expect((batchInsert!.payload as { initiated_by: string }).initiated_by).toBe('o@x.com');
  });

  it('authorization runs before formData, parseFile, and admin client', async () => {
    parseMock.mockResolvedValue(parsedOk());
    createAdminMock.mockReturnValue(makeAdmin(happyResults()));
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
    parseMock.mockRejectedValue(new Error('csv malformed at line 3 col 9'));
    const res = await POST(fileReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('PARSE_FAILED');
    expect(body.error.message).toBe('Invalid or unreadable file');
    expect(JSON.stringify(body)).not.toContain('malformed');
    expect(errSpy).toHaveBeenCalled();
  });

  it('brands lookup failure → 500 generic (no raw SQL); logs server-side', async () => {
    parseMock.mockResolvedValue(parsedOk());
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'permission denied for table brands' } }]));
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
    expect(body.error.message).toBe('Import setup failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(errSpy).toHaveBeenCalled();
  });

  it('batch insert failure → 500 generic (no raw SQL); logs server-side', async () => {
    parseMock.mockResolvedValue(parsedOk());
    createAdminMock.mockReturnValue(makeAdmin([
      { data: [], error: null }, { data: [] }, { data: [] }, { data: [] }, { data: [] },
      { data: null, error: { message: 'null value violates import_batches_pkey' } },
    ]));
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
    expect(body.error.message).toBe('Import setup failed');
    expect(JSON.stringify(body)).not.toContain('import_batches_pkey');
    expect(errSpy).toHaveBeenCalled();
  });

  it('staged rows insert failure is NOT silent → 500 generic; logs server-side', async () => {
    parseMock.mockResolvedValue(parsedOk());
    createAdminMock.mockReturnValue(makeAdmin([
      { data: [], error: null }, { data: [] }, { data: [] }, { data: [] }, { data: [] },
      { data: { id: 42 }, error: null },                              // batch ok
      { error: { message: 'deadlock detected on import_errors' } },   // staged insert fails
    ]));
    const res = await POST(fileReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
    expect(body.error.message).toBe('Import upload failed');
    expect(JSON.stringify(body)).not.toContain('deadlock');
    expect(errSpy).toHaveBeenCalled();
  });
});
