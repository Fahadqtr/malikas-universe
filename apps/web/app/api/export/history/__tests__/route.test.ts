/**
 * Route tests for GET /api/export/history — owner or editor (ROLE_SETS.writers).
 *
 * Lists past exports with the service-role client. Must authorize BEFORE query
 * parse, admin client, or DB; must NEVER return the staff email (`exported_by`)
 * — enforced by an explicit column allowlist AND a serialization allowlist —
 * and must not leak raw DB error text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { GET } from '../route';
import { ServiceError } from '@/lib/authz/errors';

/** Admin mock: records select/eq/range/order; awaiting resolves the queued result. */
function makeAdmin(result: unknown) {
  const calls = {
    selectArg: null as unknown,
    eqArgs: [] as unknown[][],
    rangeArgs: null as unknown[] | null,
    ordered: false,
  };
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result);
      return (...args: unknown[]) => {
        if (prop === 'select') calls.selectArg = args[0];
        if (prop === 'eq') calls.eqArgs.push(args);
        if (prop === 'range') calls.rangeArgs = args;
        if (prop === 'order') calls.ordered = true;
        return chain;
      };
    },
  });
  return { __calls: calls, from: vi.fn(() => chain) };
}

function req(query: Record<string, string> = {}) {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as never;
}

function fullRow() {
  // Includes exported_by to prove it is stripped even if the row carries it.
  return {
    id: 1,
    target: 'snoonu',
    format: 'csv',
    filters: { q: 'x' },
    product_count: 5,
    blocked_count: 1,
    file_bytes: 1024,
    filename: 'f.csv',
    exported_at: '2026-01-01T00:00:00Z',
    notes: 'n',
    exported_by: 'staff@example.com',
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('authorization', () => {
  it('unauthenticated → 401; requireActor(writers); no admin, no DB', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    const res = await GET(req({ target: 'all' }));
    expect(res.status).toBe(401);
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('viewer → 403; no admin, no DB', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    const res = await GET(req({ target: 'all' }));
    expect(res.status).toBe(403);
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner/editor', () => {
  it.each([['owner'], ['editor']])('%s → 200; returns history without exported_by', async (role) => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role });
    createAdminMock.mockReturnValue(makeAdmin({ data: [fullRow()], count: 1, error: null }));
    const res = await GET(req({ target: 'all' }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).not.toHaveProperty('exported_by');
  });
});

describe('invocation order', () => {
  it('auth before admin client (and thus before DB)', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin({ data: [], count: 0, error: null }));
    await GET(req({ target: 'all' }));
    expect(requireActorMock.mock.invocationCallOrder[0]!).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });
});

describe('explicit select allowlist', () => {
  it('select is explicit (no "*", no exported_by) and includes safe fields', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    const admin = makeAdmin({ data: [], count: 0, error: null });
    createAdminMock.mockReturnValue(admin);
    await GET(req({ target: 'all' }));
    const sel = admin.__calls.selectArg as string;
    expect(sel).not.toContain('*');
    expect(sel).not.toContain('exported_by');
    for (const f of ['id', 'target', 'format', 'filters', 'product_count', 'blocked_count', 'file_bytes', 'filename', 'exported_at', 'notes']) {
      expect(sel).toContain(f);
    }
  });
});

describe('response sanitization', () => {
  it('no exported_by key and no staff email anywhere, even if DB returns it', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin({ data: [fullRow()], count: 1, error: null }));
    const res = await GET(req({ target: 'all' }));
    const body = await res.json();
    expect(body.data.items[0]).not.toHaveProperty('exported_by');
    expect(JSON.stringify(body)).not.toContain('staff@example.com');
  });

  it('safe fields + envelope preserved', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin({ data: [fullRow()], count: 1, error: null }));
    const res = await GET(req({ target: 'all', limit: '20', offset: '0' }));
    const body = await res.json();
    expect(body.data.items[0]).toMatchObject({
      id: 1, target: 'snoonu', format: 'csv', filters: { q: 'x' },
      product_count: 5, blocked_count: 1, file_bytes: 1024, filename: 'f.csv',
      exported_at: '2026-01-01T00:00:00Z', notes: 'n',
    });
    expect(body.data).toMatchObject({ total: 1, limit: 20, offset: 0 });
  });
});

describe('error hardening', () => {
  it('DB failure → 500 HISTORY_FAILED / "Export history failed"; no raw; logs real error', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin({ data: null, count: null, error: { message: 'permission denied for relation export_history' } }));
    const res = await GET(req({ target: 'all' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('HISTORY_FAILED');
    expect(body.error.message).toBe('Export history failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('pagination / filter preserved', () => {
  it('target filter applies eq; range uses offset/limit; order applied', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    const admin = makeAdmin({ data: [], count: 0, error: null });
    createAdminMock.mockReturnValue(admin);
    await GET(req({ target: 'snoonu', limit: '10', offset: '30' }));
    expect(admin.__calls.eqArgs).toContainEqual(['target', 'snoonu']);
    expect(admin.__calls.rangeArgs).toEqual([30, 39]); // offset, offset+limit-1
    expect(admin.__calls.ordered).toBe(true);
  });

  it("target 'all' does not filter by target", async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    const admin = makeAdmin({ data: [], count: 0, error: null });
    createAdminMock.mockReturnValue(admin);
    await GET(req({ target: 'all' }));
    expect(admin.__calls.eqArgs.some((a) => a[0] === 'target')).toBe(false);
  });
});
