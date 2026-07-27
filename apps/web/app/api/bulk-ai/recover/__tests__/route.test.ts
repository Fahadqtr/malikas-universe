/**
 * Route tests for /api/bulk-ai/recover — owner/editor (ROLE_SETS.writers).
 *
 * GET  lists ai_drafts status='pending_recovery' only.
 * POST validates + prepares a product payload (no AI) then delegates the write
 *      to the transactional RPC `recover_ai_draft`, which guarantees exactly-one
 *      product per draft (insert + finalize in ONE transaction, FOR UPDATE).
 *
 * The payload-prep helper is stubbed so these tests focus on the recovery
 * orchestration + RPC contract; the real Suggestion schema is kept. A stateful
 * RPC mock emulates the DB's atomic semantics (single product across concurrent
 * / retried calls) so the exactly-once guarantee is actually exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, prepareProductMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  prepareProductMock: vi.fn(),
}));

vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/bulk-ai/create-product', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bulk-ai/create-product')>();
  return { ...actual, prepareProductFromSuggestion: prepareProductMock };
});

import { GET, POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

// ─── Stateful admin mock: from() lookups + a transactional recover_ai_draft ────

type Cfg = {
  draft?: Record<string, unknown> | null;
  products?: Array<{ id: number; master_sku: string }>;
  brand?: { id: number } | null;
  category?: { id: number } | null;
  subcategory?: { id: number; category_id: number } | null;
  list?: { data: unknown[]; count: number; error: unknown };
  loadErr?: unknown;
  forcePendingLoad?: boolean; // simulate a stale "pending" read during a race
  rpcFail?: boolean;          // simulate a transaction failure (rollback)
};

function makeAdmin(cfg: Cfg) {
  const state = {
    draft: cfg.draft ? { ...cfg.draft } as Record<string, unknown> : cfg.draft, // mutable
    products: [...(cfg.products ?? [])],
    productSeq: cfg.products?.length ?? 0,
    calls: { rpc: [] as Array<{ name: string; params: Record<string, unknown> }>, productInsert: 0, aiDraftUpdate: 0 },
  };

  function builder(table: string) {
    const ctx: { select?: string; isCount?: boolean; eqs: Array<[string, unknown]> } = { eqs: [] };

    const resolve = () => {
      if (table === 'ai_drafts') {
        if (ctx.isCount) return cfg.list ?? { data: [], count: 0, error: null };
        if (ctx.select?.includes('suggestion')) {
          if (cfg.loadErr) return { data: null, error: cfg.loadErr };
          if (!state.draft) return { data: null, error: null };
          const d = cfg.forcePendingLoad ? { ...state.draft, status: 'pending_recovery' } : { ...state.draft };
          return { data: d, error: null };
        }
        return { data: null, error: null };
      }
      if (table === 'products') {
        const sku = ctx.eqs.find((e) => e[0] === 'master_sku')?.[1];
        return { data: state.products.find((p) => p.master_sku === sku) ?? null, error: null };
      }
      if (table === 'brands') return { data: cfg.brand ?? null, error: null };
      if (table === 'categories') return { data: cfg.category ?? null, error: null };
      if (table === 'subcategories') return { data: cfg.subcategory ?? null, error: null };
      return { data: null, error: null };
    };

    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            Promise.resolve(resolve()).then(res, rej);
        }
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(resolve());
        return (...args: unknown[]) => {
          if (prop === 'select') { ctx.select = args[0] as string; if ((args[1] as { count?: string })?.count) ctx.isCount = true; }
          if (prop === 'eq') ctx.eqs.push(args as [string, unknown]);
          if (prop === 'insert' && table === 'products') state.calls.productInsert += 1;
          if (prop === 'update' && table === 'ai_drafts') state.calls.aiDraftUpdate += 1;
          return proxy;
        };
      },
    });
    return proxy;
  }

  // Transactional RPC — emulates recover_ai_draft's atomic, idempotent contract.
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    state.calls.rpc.push({ name, params });
    if (name !== 'recover_ai_draft') return { data: null, error: { message: 'unknown function' } };
    const d = state.draft as Record<string, unknown> | null | undefined;
    if (!d || d.id !== params.p_draft_id) return { data: null, error: { message: 'DRAFT_NOT_FOUND' } };
    if (d.status === 'recovered') {
      const p = state.products.find((pr) => pr.master_sku === d.recovered_master_sku);
      return { data: [{ already_recovered: true, product_id: p?.id ?? null, master_sku: d.recovered_master_sku }], error: null };
    }
    if (d.status !== 'pending_recovery') return { data: null, error: { message: `DRAFT_NOT_RECOVERABLE:${d.status}` } };
    if (cfg.rpcFail) return { data: null, error: { message: 'deadlock detected', code: '40P01' } }; // rollback: no state change
    state.productSeq += 1;
    const sku = `MK-X-000${state.productSeq}`;
    state.products.push({ id: state.productSeq, master_sku: sku });
    d.status = 'recovered';
    d.recovered_master_sku = sku;
    return { data: [{ already_recovered: false, product_id: state.productSeq, master_sku: sku }], error: null };
  });

  return { __state: state, from: vi.fn((t: string) => builder(t)), rpc };
}

function getReq(query: Record<string, string> = {}) {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as never;
}
function postReq(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}

function validDraft(over: Record<string, unknown> = {}) {
  return {
    id: 7, status: 'pending_recovery',
    suggestion: { product_name_en: 'Widget', product_name_ar: 'ودجت', brand_hint: 'Anua' },
    confidence: 0.6, ai_meta: { model: 'haiku' }, image_url: 'https://img/x.jpg',
    original_filename: 'x.jpg', recovered_master_sku: null, ...over,
  };
}
const preparedOk = {
  ok: true,
  prepared: {
    payload: { product_name_en: 'Widget', product_name_ar: 'ودجت', brand_id: 1, category_id: 11, ai_meta: {} },
    resolved: { brand_id: 1, category_id: 11, subcategory_id: null },
  },
};

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  prepareProductMock.mockResolvedValue(preparedOk);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

// ─── A. GET auth ──────────────────────────────────────────────────────────────
describe('A. GET auth', () => {
  it('unauthenticated → 401; requireActor(writers)', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect(createAdminMock).not.toHaveBeenCalled();
  });
  it('viewer → 403', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    const res = await GET(getReq());
    expect(res.status).toBe(403);
    expect(createAdminMock).not.toHaveBeenCalled();
  });
  it.each([['owner'], ['editor']])('%s → 200', async (role) => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role });
    createAdminMock.mockReturnValue(makeAdmin({ list: { data: [], count: 0, error: null } }));
    const res = await GET(getReq());
    expect(res.status).toBe(200);
  });
});

// ─── B. GET pending only + pagination ─────────────────────────────────────────
describe('B. GET pending-only + pagination', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('queries status=pending_recovery, clamped limit, returns items+total', async () => {
    const admin = makeAdmin({ list: { data: [{ id: 3 }, { id: 2 }], count: 2, error: null } });
    createAdminMock.mockReturnValue(admin);
    const res = await GET(getReq({ limit: '500', offset: '10' })); // 500 must clamp to 100
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data).toMatchObject({ total: 2, limit: 100, offset: 10 });
    expect(admin.from).toHaveBeenCalledWith('ai_drafts');
  });

  it('DB error → 500 RECOVER_LIST_FAILED, generic message', async () => {
    createAdminMock.mockReturnValue(makeAdmin({ list: { data: null as never, count: 0, error: { message: 'permission denied for ai_drafts' } } }));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('RECOVER_LIST_FAILED');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });
});

// ─── C. POST validation ───────────────────────────────────────────────────────
describe('C. POST validation', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('missing/invalid draftId → 400, no RPC', async () => {
    const admin = makeAdmin({});
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ overrides: {} }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_REQUEST');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('draft not found → 404, no RPC', async () => {
    const admin = makeAdmin({ draft: null });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 999 }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('DRAFT_NOT_FOUND');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('invalid stored suggestion → 422, no RPC', async () => {
    const admin = makeAdmin({ draft: validDraft({ suggestion: { product_name_en: 123 } }) });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 7 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('INVALID_SUGGESTION');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('override brandId not found → 400', async () => {
    const admin = makeAdmin({ draft: validDraft(), brand: null });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 7, overrides: { brandId: 42 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_BRAND');
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('override categoryId not found → 400', async () => {
    const admin = makeAdmin({ draft: validDraft(), category: null });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 7, overrides: { categoryId: 42 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_CATEGORY');
  });
});

// ─── D. Successful recovery via RPC ───────────────────────────────────────────
describe('D. successful recovery', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'user-uuid-1', email: 'a@x.com', role: 'owner' }));

  it('calls recover_ai_draft once (no products.insert / no ai_drafts update in route)', async () => {
    const admin = makeAdmin({
      draft: validDraft(), brand: { id: 10 }, category: { id: 5 }, subcategory: { id: 9, category_id: 5 },
    });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({
      draftId: 7, overrides: { brandId: 10, categoryId: 5, subcategoryId: 9, productNameEn: 'Override EN' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ ok: true, alreadyRecovered: false, masterSku: 'MK-X-0001', productId: 1 });
    expect(body.data.resolved).toMatchObject({ brand_id: 1, category_id: 11 });

    // prepare called with merged suggestion (text override) + id overrides
    expect(prepareProductMock).toHaveBeenCalledTimes(1);
    const prepArg = prepareProductMock.mock.calls[0]![0] as { overrides: Record<string, unknown>; suggestion: Record<string, unknown> };
    expect(prepArg.overrides).toMatchObject({ brandId: 10, categoryId: 5, subcategoryId: 9 });
    expect(prepArg.suggestion).toMatchObject({ product_name_en: 'Override EN', product_name_ar: 'ودجت', brand_hint: 'Anua' });

    // exactly one RPC, with the actor uuid + email + prepared payload
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    const rpcCall = admin.__state.calls.rpc[0]!;
    expect(rpcCall.name).toBe('recover_ai_draft');
    expect(rpcCall.params).toMatchObject({ p_draft_id: 7, p_actor_id: 'user-uuid-1', p_actor_email: 'a@x.com' });

    // payload never carries audit fields (created_by/updated_by are forced in SQL)
    const pl = rpcCall.params.p_product_payload as Record<string, unknown>;
    expect(pl).toBeTruthy();
    expect(pl).not.toHaveProperty('created_by');
    expect(pl).not.toHaveProperty('updated_by');
    expect(pl).not.toHaveProperty('master_sku');

    // route performs NO product insert and NO ai_drafts update (all inside RPC)
    expect(admin.__state.calls.productInsert).toBe(0);
    expect(admin.__state.calls.aiDraftUpdate).toBe(0);
  });
});

// ─── E. Idempotent retry (already recovered) — RPC is the source of truth ─────
describe('E. idempotent retry (already recovered)', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('draft already recovered → RPC called once (no prep, no insert), returns existing product', async () => {
    const admin = makeAdmin({
      draft: validDraft({ status: 'recovered', recovered_master_sku: 'MK-X-0001' }),
      products: [{ id: 1, master_sku: 'MK-X-0001' }],
    });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 7 }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ ok: true, alreadyRecovered: true, masterSku: 'MK-X-0001', productId: 1 });
    // idempotency is decided by the atomic function, not a route fast-path:
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.__state.calls.rpc[0]!.params.p_product_payload).toEqual({}); // no product prepared
    expect(prepareProductMock).not.toHaveBeenCalled();                        // no brand/category prep
    expect(admin.__state.calls.productInsert).toBe(0);                        // no app-side insert
  });

  it('recovered but product missing → 500 RECOVERY_INCONSISTENT (server data-safety, no DB leak)', async () => {
    const admin = makeAdmin({ draft: validDraft({ status: 'recovered', recovered_master_sku: 'MK-X-0009' }), products: [] });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 7 }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('RECOVERY_INCONSISTENT');
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain('MK-X-0009'); // no internal detail leaked
  });
});

// ─── F. Concurrent recovery → EXACTLY ONE product ─────────────────────────────
describe('F. concurrent recovery (RPC guarantees one product)', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('two racing calls (both read pending) create only ONE product', async () => {
    // forcePendingLoad: both requests see a stale "pending" load — the RPC's
    // FOR UPDATE + status re-check is the only thing preventing a duplicate.
    const admin = makeAdmin({ draft: validDraft(), forcePendingLoad: true });
    createAdminMock.mockReturnValue(admin);

    const r1 = await POST(postReq({ draftId: 7 }));
    const r2 = await POST(postReq({ draftId: 7 }));
    const b1 = (await r1.json()).data;
    const b2 = (await r2.json()).data;

    // exactly one product overall
    expect(admin.__state.productSeq).toBe(1);
    expect(admin.__state.products).toHaveLength(1);
    // one call created, the other observed already-recovered — both point at #1
    const flags = [b1.alreadyRecovered, b2.alreadyRecovered].sort();
    expect(flags).toEqual([false, true]);
    expect(b1.productId).toBe(1);
    expect(b2.productId).toBe(1);
    expect(admin.rpc).toHaveBeenCalledTimes(2);
    expect(admin.__state.calls.productInsert).toBe(0);
  });
});

// ─── G. Transaction failure → no product, no partial finalize ─────────────────
describe('G. transaction failure (RPC error → rollback)', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('RPC fails → 500 RECOVERY_PRODUCT_FAILED, no product, draft stays pending', async () => {
    const admin = makeAdmin({ draft: validDraft(), rpcFail: true });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(postReq({ draftId: 7 }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('RECOVERY_PRODUCT_FAILED');
    expect(JSON.stringify(body)).not.toContain('deadlock'); // no raw DB error leaked
    // rollback semantics: nothing created, draft untouched, no app-side finalize
    expect(admin.__state.productSeq).toBe(0);
    expect(admin.__state.draft!.status).toBe('pending_recovery');
    expect(admin.__state.calls.aiDraftUpdate).toBe(0);
    expect(admin.__state.calls.productInsert).toBe(0);
  });
});

// ─── H. Committed transaction but response lost, then retry → count = 1 ────────
describe('H. response-lost retry (RPC committed) ⇒ products count = 1', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('first call commits (response "lost"), retry returns the same product; still ONE product', async () => {
    const admin = makeAdmin({ draft: validDraft() });
    createAdminMock.mockReturnValue(admin);

    // Call 1 commits the recovery (product #1, draft → recovered) — imagine the
    // HTTP response never reaches the client.
    const r1 = await POST(postReq({ draftId: 7 }));
    expect((await r1.json()).data).toMatchObject({ ok: true, alreadyRecovered: false, productId: 1 });
    expect(admin.__state.productSeq).toBe(1);

    // Client retries. Draft now reads 'recovered' → existing product returned.
    const r2 = await POST(postReq({ draftId: 7 }));
    expect(r2.status).toBe(200);
    expect((await r2.json()).data).toMatchObject({ ok: true, alreadyRecovered: true, productId: 1 });

    // PROOF: still exactly one product after the retry.
    expect(admin.__state.productSeq).toBe(1);
    expect(admin.__state.products).toHaveLength(1);
    expect(admin.__state.calls.productInsert).toBe(0);
  });
});
