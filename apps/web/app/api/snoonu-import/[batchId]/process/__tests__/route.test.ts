/**
 * Route tests for POST /api/snoonu-import/[batchId]/process — owner only.
 *
 * This endpoint runs an extract → image-pull → match pipeline with the
 * service-role client (external fetch + Supabase Storage + bulk DB writes), so
 * it must be gated to `owner` BEFORE batchId parse, admin client, DB, Storage,
 * or any external fetch, and it must never persist/return raw provider errors
 * (snoonu_import_items.error_message must stay generic).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  requireActorMock,
  createAdminMock,
  extractMock,
  inferCategoryMock,
  genSkuMock,
  pullImageMock,
  detectVariantsMock,
  matchMock,
  quickImageMock,
} = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  extractMock: vi.fn(),
  inferCategoryMock: vi.fn(),
  genSkuMock: vi.fn(),
  pullImageMock: vi.fn(),
  detectVariantsMock: vi.fn(),
  matchMock: vi.fn(),
  quickImageMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/snoonu/extractor', () => ({ extractSnoonuProduct: extractMock }));
vi.mock('@/lib/master-categories', () => ({ inferMasterCategory: inferCategoryMock }));
vi.mock('@/lib/sku-generator', () => ({ generateParentSku: genSkuMock }));
vi.mock('@/lib/snoonu/image-pull', () => ({ pullImageForSku: pullImageMock }));
vi.mock('@/lib/snoonu/variant-detector', () => ({ detectVariants: detectVariantsMock }));
vi.mock('@/lib/snoonu/matcher', () => ({ matchExistingProduct: matchMock }));
vi.mock('@/lib/snoonu/enricher', () => ({ quickImageCheck: quickImageMock }));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

function makeAdmin(results: unknown[]) {
  let i = 0;
  const updates: Array<{ table: string; payload: unknown }> = [];
  const admin = {
    __updates: updates,
    from(table: string) {
      const chain: unknown = new Proxy(function () {}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null });
          return (...args: unknown[]) => {
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

const req = {} as never;
const ctx = { params: { batchId: '5' } };

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults for the pipeline libs (unused on the empty/owner-gate paths).
  inferCategoryMock.mockReturnValue({ category: 'Makeup' });
  genSkuMock.mockResolvedValue('SKU1');
  pullImageMock.mockResolvedValue({ ok: false, reason: 'no_image' });
  detectVariantsMock.mockReturnValue([]);
  matchMock.mockResolvedValue({ kind: 'new' });
  quickImageMock.mockReturnValue({ issues: [] });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('non-owner blocked before batchId parse / admin / fetch / storage', () => {
  it.each([
    ['unauthenticated', new ServiceError('UNAUTHORIZED', 'Login required', 401), 401],
    ['editor', new ServiceError('FORBIDDEN', 'Role editor not allowed', 403), 403],
    ['viewer', new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403), 403],
  ])('%s → %s; no admin, no fetch, no storage', async (_l, thrown, status) => {
    requireActorMock.mockRejectedValue(thrown);
    const res = await POST(req, ctx);
    expect(res.status).toBe(status);
    expect(createAdminMock).not.toHaveBeenCalled();
    expect(extractMock).not.toHaveBeenCalled();
    expect(pullImageMock).not.toHaveBeenCalled();
  });

  it('authorization runs before batchId validation (invalid id still 403, not 400)', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    const res = await POST(req, { params: { batchId: 'not-a-number' } });
    expect(res.status).toBe(403);
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('requireActor called with ownerOnly; reaches batch read; empty batch processes 0', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: { id: 5, status: 'pending', total_items: 0 } }, // batch read
      {},                                                     // lock → extracting
      { data: [] },                                           // items load (none)
      {},                                                     // finalize batch
    ]));
    const res = await POST(req, ctx);
    expect(requireActorMock).toHaveBeenCalledWith(['owner']);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ batch_id: 5, processed: 0, status: 'review_ready' });
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('authorization runs before the admin client', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: { id: 5, status: 'pending', total_items: 0 } },
      {},
      { data: [] },
      {},
    ]));
    await POST(req, ctx);
    expect(requireActorMock.mock.invocationCallOrder[0]!).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
  });

  it('extract failure → real reason logged server-side; error_message column = extract_failed; response has no provider text', async () => {
    extractMock.mockResolvedValue({ ok: false, reason: 'HTTP 503 upstream snoonu blocked xyz' });
    const admin = makeAdmin([
      { data: { id: 5, status: 'pending', total_items: 1 } },              // batch read
      {},                                                                  // lock → extracting
      { data: [{ id: 101, source_url: 'https://snoonu.com/p', status: 'pending' }] }, // items
      {},                                                                  // item → extracting
      {},                                                                  // item → error
      {},                                                                  // finalize batch
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.failed).toBe(1);
    // Real reason was logged server-side...
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('item 101'), 'HTTP 503 upstream snoonu blocked xyz');
    // ...but never persisted or returned.
    const itemErr = admin.__updates.find(
      (u) => u.table === 'snoonu_import_items' && (u.payload as { status?: string }).status === 'error',
    );
    expect(itemErr).toBeDefined();
    expect((itemErr!.payload as { error_message: string }).error_message).toBe('extract_failed');
    expect(JSON.stringify(admin.__updates)).not.toContain('xyz');
    expect(JSON.stringify(body)).not.toContain('xyz');
  });

  it('thrown pipeline error → logged server-side; error_message column = process_failed; no leak in response', async () => {
    extractMock.mockRejectedValue(new Error('BOOM_secret_stack_detail'));
    const admin = makeAdmin([
      { data: { id: 5, status: 'pending', total_items: 1 } },
      {},
      { data: [{ id: 102, source_url: 'https://snoonu.com/p2', status: 'pending' }] },
      {}, // item → extracting
      {}, // item → error (catch)
      {}, // finalize batch
    ]);
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.failed).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const itemErr = admin.__updates.find(
      (u) => u.table === 'snoonu_import_items' && (u.payload as { status?: string }).status === 'error',
    );
    expect(itemErr).toBeDefined();
    expect((itemErr!.payload as { error_message: string }).error_message).toBe('process_failed');
    expect(JSON.stringify(admin.__updates)).not.toContain('BOOM_secret');
    expect(JSON.stringify(body)).not.toContain('BOOM_secret');
  });
});
