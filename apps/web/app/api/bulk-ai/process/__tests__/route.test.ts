/**
 * Regression tests for /api/bulk-ai/process (test set H).
 *
 * Goal: prove that extracting the product-creation step into the shared
 * `createProductFromSuggestion` helper did NOT change the route's external
 * behaviour. The REAL helper is used (not stubbed) so the insert payload,
 * defaults and safety-net fallthrough are exercised end-to-end; only the true
 * boundaries are mocked — Claude (@/lib/claude), the actor (@/lib/actor) and
 * the Supabase admin client (@/lib/supabase/server).
 *
 * H covers:
 *   - owner/editor happy path → product created ONCE with the same payload
 *     (price 0 / stock defaults / ai_generated / resolved FKs), image linked,
 *     status derived from confidence.
 *   - products INSERT failure → AI output saved to ai_drafts safety net,
 *     response `draft_saved_to_safety_net`, nothing thrown.
 *   - role enforcement: viewer → 403, unauthenticated → 401, no Claude call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getActorMock, createAdminMock, callClaudeJsonMock } = vi.hoisted(() => ({
  getActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  callClaudeJsonMock: vi.fn(),
}));

vi.mock('@/lib/actor', () => ({ getActor: getActorMock }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/claude', () => ({
  callClaudeJson: callClaudeJsonMock,
  estimateCostUsd: vi.fn(() => 0.0012),
  MODELS: { haiku: 'claude-haiku-test', sonnet: 'claude-sonnet-test' },
}));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

// ─── Configurable admin mock (real helper drives most of the chains) ──────────

type Cfg = {
  brandExisting?: { id: number } | null; // brands ilike lookup
  brandInsert?: { data: { id: number } | null; error: unknown }; // brands auto-create
  category?: { id: number } | null;
  subcategory?: { id: number } | null;
  productInsert?: { data: Record<string, unknown> | null; error: unknown };
  safetyNet?: { data: { id: number } | null; error: unknown };
};

function makeAdmin(cfg: Cfg) {
  const calls = {
    productInserts: [] as Record<string, unknown>[],
    brandInserts: 0,
    aiDraftInserts: [] as Record<string, unknown>[],
    imageInserts: 0,
    usageInserts: 0,
    schemaProbes: 0,
  };

  function builder(table: string) {
    const ctx: {
      table: string; select?: string; insert?: Record<string, unknown>;
      limit?: boolean; eqs: Array<[string, unknown]>;
    } = { table, eqs: [] };

    const resolve = () => {
      switch (table) {
        case 'products':
          if (ctx.insert) {
            calls.productInserts.push(ctx.insert);
            return cfg.productInsert ?? { data: null, error: null };
          }
          // ensureSchema probe (select + limit, no insert)
          calls.schemaProbes += 1;
          return { data: [{ id: 1 }], error: null };
        case 'brands':
          if (ctx.insert) {
            calls.brandInserts += 1;
            return cfg.brandInsert ?? { data: { id: 3 }, error: null };
          }
          return { data: cfg.brandExisting ?? null, error: null };
        case 'categories':
          return { data: cfg.category ?? null, error: null };
        case 'subcategories':
          return { data: cfg.subcategory ?? null, error: null };
        case 'product_images':
          calls.imageInserts += 1;
          return { data: null, error: null };
        case 'ai_usage_log':
          calls.usageInserts += 1;
          return { data: null, error: null };
        case 'ai_drafts':
          calls.aiDraftInserts.push(ctx.insert ?? {});
          return cfg.safetyNet ?? { data: { id: 4242 }, error: null };
        default:
          return { data: null, error: null };
      }
    };

    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            Promise.resolve(resolve()).then(res, rej);
        }
        if (prop === 'maybeSingle' || prop === 'single') {
          return () => Promise.resolve(resolve());
        }
        return (...args: unknown[]) => {
          if (prop === 'select') ctx.select = args[0] as string;
          if (prop === 'insert') ctx.insert = args[0] as Record<string, unknown>;
          if (prop === 'limit') ctx.limit = true;
          if (prop === 'eq') ctx.eqs.push(args as [string, unknown]);
          return proxy;
        };
      },
    });
    return proxy;
  }

  return { __calls: calls, from: vi.fn((t: string) => builder(t)) };
}

function postReq(body: unknown) {
  return { json: vi.fn().mockResolvedValue(body) } as never;
}

const BODY = { image_url: 'https://cdn/x/serum.jpg', original_filename: 'serum.jpg' };

// A suggestion with both AR + EN name and no EN-only long fields → no AR
// fallback pass, so callClaudeJson is invoked exactly once.
function suggestion(over: Record<string, unknown> = {}) {
  return {
    product_name_en: 'Glow Serum',
    product_name_ar: 'سيروم التوهج',
    brand_hint: 'Anua',
    category_hint: 'Skincare',
    confidence: 0.95,
    ...over,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  callClaudeJsonMock.mockResolvedValue({ data: suggestion(), usage: { input: 120, output: 240 } });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
});

// ─── H1. Happy path — product created once with the same payload ──────────────
describe('H1. owner happy path', () => {
  it('creates the product once with unchanged defaults, links image, derives status', async () => {
    getActorMock.mockResolvedValue({ id: 'u', email: 'owner@x.com', role: 'owner' });
    const admin = makeAdmin({
      brandExisting: { id: 3 },
      category: { id: 5 },
      productInsert: {
        data: { id: 1, master_sku: 'MU-0001', ai_confidence: 0.95, product_name_en: 'Glow Serum', product_name_ar: 'سيروم التوهج' },
        error: null,
      },
    });
    createAdminMock.mockReturnValue(admin);

    const res = await POST(postReq(BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      status: 'ready', // confidence 0.95 >= 0.9
      master_sku: 'MU-0001',
      product_id: 1,
      resolved: { brand_id: 3, category_id: 5, subcategory_id: null },
    });

    // Claude called exactly once (no AR fallback needed)
    expect(callClaudeJsonMock).toHaveBeenCalledTimes(1);

    // Product inserted exactly once, with the unchanged defaults + resolved FKs
    expect(admin.__calls.productInserts).toHaveLength(1);
    const payload = admin.__calls.productInserts[0]!;
    expect(payload).toMatchObject({
      product_name_en: 'Glow Serum',
      product_name_ar: 'سيروم التوهج',
      brand_id: 3,
      category_id: 5,
      subcategory_id: null,
      price: 0,
      stock_quantity: 0,
      stock_status: 'out_of_stock',
      product_status: 'draft',
      source_platform: 'manual',
      ai_generated: true,
      ai_confidence: 0.95,
      image_url: BODY.image_url,
      image_filename: BODY.original_filename,
      created_by: 'owner@x.com',
      updated_by: 'owner@x.com',
    });

    // Image linked, usage logged, and NO safety-net draft written on success
    expect(admin.__calls.imageInserts).toBe(1);
    expect(admin.__calls.usageInserts).toBe(1);
    expect(admin.__calls.aiDraftInserts).toHaveLength(0);
  });
});

// ─── H2. INSERT failure → safety net (AI output never lost) ───────────────────
describe('H2. products insert failure → safety net', () => {
  it('saves the AI output to ai_drafts and returns draft_saved_to_safety_net (no throw)', async () => {
    getActorMock.mockResolvedValue({ id: 'u', email: 'editor@x.com', role: 'editor' });
    const admin = makeAdmin({
      brandExisting: { id: 3 },
      category: { id: 5 },
      productInsert: { data: null, error: { message: 'null value in column "price"', code: '23502' } },
      safetyNet: { data: { id: 909 }, error: null },
    });
    createAdminMock.mockReturnValue(admin);

    // A throw here would reject this await and fail the test — so reaching the
    // assertions below IS the "never throws / AI output never lost" guarantee.
    const res = await POST(postReq(BODY));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      status: 'draft_saved_to_safety_net',
      ai_draft_id: 909,
    });
    expect(body.data.error).toMatchObject({ failing_table: 'products' });

    // product insert attempted, then AI output saved to ai_drafts exactly once
    expect(admin.__calls.productInserts).toHaveLength(1);
    expect(admin.__calls.aiDraftInserts).toHaveLength(1);
    expect(admin.__calls.aiDraftInserts[0]).toMatchObject({
      status: 'pending_recovery',
      failing_table: 'products',
      created_by: 'editor@x.com',
    });
    // image is NOT linked when the product never inserted
    expect(admin.__calls.imageInserts).toBe(0);
  });
});

// ─── H3 / H4. Role enforcement (owner/editor only) ────────────────────────────
describe('H3/H4. role enforcement', () => {
  it('viewer → 403 FORBIDDEN, Claude never called, no product insert', async () => {
    getActorMock.mockResolvedValue({ id: 'u', email: 'v@x.com', role: 'viewer' });
    const admin = makeAdmin({});
    createAdminMock.mockReturnValue(admin);

    const res = await POST(postReq(BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(callClaudeJsonMock).not.toHaveBeenCalled();
    expect(admin.__calls.productInserts).toHaveLength(0);
  });

  it('unauthenticated (getActor throws) → 401, Claude never called', async () => {
    getActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    createAdminMock.mockReturnValue(makeAdmin({}));

    const res = await POST(postReq(BODY));
    expect(res.status).toBe(401);
    expect(callClaudeJsonMock).not.toHaveBeenCalled();
  });
});
