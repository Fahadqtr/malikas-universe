/**
 * Route tests for POST /api/images/upload — owner or editor (ROLE_SETS.writers).
 *
 * Uploads a product image to Supabase Storage (bucket product-images) with the
 * service-role client and writes product_images/products, so it must authorize
 * BEFORE formData, file read, admin client, product lookup, Storage, or DB, and
 * it must never leak raw DB/Storage error text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, uploadImageMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  uploadImageMock: vi.fn(),
}));
vi.mock('@/lib/authorization', () => ({
  requireActor: requireActorMock,
  ROLE_SETS: { ownerOnly: ['owner'], writers: ['owner', 'editor'], readers: ['owner', 'editor', 'viewer'] },
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminSupabaseClient: createAdminMock,
  createServerSupabaseClient: vi.fn(),
}));
vi.mock('@/lib/supabase/storage', () => ({
  uploadImage: uploadImageMock,
}));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

/** Chainable admin mock: FIFO results; records insert/update payloads by table. */
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
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(results[i++] ?? { data: null, error: null });
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

function makeFile(overrides: Partial<{ type: string; size: number; name: string }> = {}) {
  return {
    type: overrides.type ?? 'image/jpeg',
    size: overrides.size ?? 2048,
    name: overrides.name ?? 'Photo 1.JPG',
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
  };
}
function req(fields: { file?: unknown; master_sku?: string | null; is_primary?: boolean }) {
  const form = {
    get: vi.fn((k: string) => {
      if (k === 'file') return fields.file ?? null;
      if (k === 'master_sku') return fields.master_sku ?? null;
      if (k === 'is_primary') return fields.is_primary ? 'true' : null;
      return null;
    }),
  };
  return { formData: vi.fn().mockResolvedValue(form), __form: form } as never;
}

// Happy-path DB queue for is_primary=true: product lookup, clear-primary, delete, insert, products update.
function happyPrimary() {
  return [
    { data: { master_sku: 'SKU1' }, error: null },                      // product lookup
    { data: null, error: null },                                        // clear-primary update
    { data: null, error: null },                                        // delete r2_key
    { data: { id: 9, master_sku: 'SKU1', r2_key: 'products/sku1/primary.jpg', is_primary: true }, error: null }, // insert
    { data: null, error: null },                                        // products update
  ];
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  uploadImageMock.mockResolvedValue({ path: 'products/sku1/primary.jpg', url: 'https://public.example/products/sku1/primary.jpg' });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('authorization', () => {
  it('unauthenticated → 401; requireActor(writers); no formData, no arrayBuffer, no admin, no storage', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    const file = makeFile();
    const rq = req({ file, master_sku: 'SKU1' });
    const res = await POST(rq);
    expect(res.status).toBe(401);
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect((rq as { formData: ReturnType<typeof vi.fn> }).formData).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
    expect(uploadImageMock).not.toHaveBeenCalled();
  });

  it('viewer → 403; no file read, no admin, no storage, no DB', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    const file = makeFile();
    const rq = req({ file, master_sku: 'SKU1' });
    const res = await POST(rq);
    expect(res.status).toBe(403);
    expect((rq as { formData: ReturnType<typeof vi.fn> }).formData).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
    expect(uploadImageMock).not.toHaveBeenCalled();
  });
});

describe('happy path', () => {
  it('owner + is_primary → 201; looks up product, uploads (upsert:true), writes product_images + products', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' });
    const admin = makeAdmin(happyPrimary());
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req({ file: makeFile(), master_sku: 'SKU1', is_primary: true }));
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect(res.status).toBe(201);
    const body = await res.json();
    // success response shape preserved
    expect(body.data).toMatchObject({ url: 'https://public.example/products/sku1/primary.jpg', path: 'products/sku1/primary.jpg' });
    expect(body.data.image).toMatchObject({ id: 9, master_sku: 'SKU1' });
    // storage helper called with upsert:true + primary filename
    expect(uploadImageMock).toHaveBeenCalledWith(expect.objectContaining({ master_sku: 'SKU1', filename: 'primary.jpg', content_type: 'image/jpeg', upsert: true }));
    // DB writes preserved: product_images insert + products update
    expect(admin.__inserts.some((x) => x.table === 'product_images')).toBe(true);
    expect(admin.__updates.some((x) => x.table === 'products')).toBe(true);
  });

  it('editor + non-primary → 201; editor allowed; uploads with client-derived filename', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'e@x.com', role: 'editor' });
    createAdminMock.mockReturnValue(makeAdmin([
      { data: { master_sku: 'SKU1' }, error: null }, // lookup
      { data: null, error: null },                   // delete r2_key
      { data: { id: 10, master_sku: 'SKU1' }, error: null }, // insert
    ]));
    const res = await POST(req({ file: makeFile({ name: 'My Photo.JPG' }), master_sku: 'SKU1', is_primary: false }));
    expect(res.status).toBe(201);
    expect(uploadImageMock).toHaveBeenCalledWith(expect.objectContaining({ filename: 'my-photo.jpg', upsert: true }));
  });
});

describe('invocation order', () => {
  it('auth before formData, arrayBuffer, admin client, and Storage', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin(happyPrimary()));
    const file = makeFile();
    const rq = req({ file, master_sku: 'SKU1', is_primary: true });
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { formData: ReturnType<typeof vi.fn> }).formData.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(file.arrayBuffer.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(uploadImageMock.mock.invocationCallOrder[0]!);
  });
});

describe('error hardening', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('product lookup DB failure → 500 DB_ERROR / "Image upload setup failed"; no raw; no upload/insert', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: { message: 'permission denied for relation products' } }]));
    const res = await POST(req({ file: makeFile(), master_sku: 'SKU1' }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_ERROR');
    expect(body.error.message).toBe('Image upload setup failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(uploadImageMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });

  it('product not found → 404 NO_PRODUCT (unchanged)', async () => {
    createAdminMock.mockReturnValue(makeAdmin([{ data: null, error: null }]));
    const res = await POST(req({ file: makeFile(), master_sku: 'MISSING' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NO_PRODUCT');
    expect(uploadImageMock).not.toHaveBeenCalled();
  });

  it('storage/helper failure → 500 STORAGE_UPLOAD_FAILED / "Image upload failed"; no raw; no image insert', async () => {
    const admin = makeAdmin([{ data: { master_sku: 'SKU1' }, error: null }]);
    createAdminMock.mockReturnValue(admin);
    uploadImageMock.mockRejectedValue(new Error('bucket policy denied object insert secret-path'));
    const res = await POST(req({ file: makeFile(), master_sku: 'SKU1', is_primary: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('STORAGE_UPLOAD_FAILED');
    expect(body.error.message).toBe('Image upload failed');
    expect(JSON.stringify(body)).not.toContain('bucket policy');
    expect(admin.__inserts).toHaveLength(0); // no product_images insert after failed upload
    expect(errSpy).toHaveBeenCalled();
  });

  it('product_images insert failure → 500 DB_INSERT_FAILED / "Image upload failed"; no constraint/raw text', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: { master_sku: 'SKU1' }, error: null }, // lookup
      { data: null, error: null },                   // delete
      { data: null, error: { message: 'duplicate key violates product_images_pkey' } }, // insert fails
    ]));
    const res = await POST(req({ file: makeFile(), master_sku: 'SKU1', is_primary: false }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_INSERT_FAILED');
    expect(body.error.message).toBe('Image upload failed');
    expect(JSON.stringify(body)).not.toContain('product_images_pkey');
    expect(errSpy).toHaveBeenCalled();
  });

  it('products update failure → 500 DB_UPDATE_FAILED / "Image upload failed"; no raw; logs real error', async () => {
    createAdminMock.mockReturnValue(makeAdmin([
      { data: { master_sku: 'SKU1' }, error: null }, // lookup
      { data: null, error: null },                   // clear-primary
      { data: null, error: null },                   // delete
      { data: { id: 9 }, error: null },              // insert ok
      { data: null, error: { message: 'permission denied for relation products' } }, // products update fails
    ]));
    const res = await POST(req({ file: makeFile(), master_sku: 'SKU1', is_primary: true }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('DB_UPDATE_FAILED');
    expect(body.error.message).toBe('Image upload failed');
    expect(JSON.stringify(body)).not.toContain('permission denied');
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('existing file validation preserved (owner)', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'o@x.com', role: 'owner' }));

  it('no file → 400 NO_FILE', async () => {
    const res = await POST(req({ file: null, master_sku: 'SKU1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NO_FILE');
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('missing master_sku → 400 NO_SKU', async () => {
    const res = await POST(req({ file: makeFile(), master_sku: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NO_SKU');
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('invalid type → 400 BAD_FORMAT', async () => {
    const res = await POST(req({ file: makeFile({ type: 'image/gif' }), master_sku: 'SKU1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_FORMAT');
  });

  it('oversized → 400 TOO_LARGE', async () => {
    const res = await POST(req({ file: makeFile({ size: 5 * 1024 * 1024 + 1 }), master_sku: 'SKU1' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('TOO_LARGE');
  });
});
