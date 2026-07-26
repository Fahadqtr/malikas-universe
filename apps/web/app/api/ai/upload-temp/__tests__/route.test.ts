/**
 * Route tests for POST /api/ai/upload-temp — owner or editor (ROLE_SETS.writers).
 *
 * Uploads a temp image to product-images/ai-autofill-temp/{uuid} with the
 * service-role client, so it must authorize BEFORE formData, file read,
 * arrayBuffer, admin client, or Storage, and it must never leak raw Storage
 * error text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requireActorMock, createAdminMock, publicUrlMock } = vi.hoisted(() => ({
  requireActorMock: vi.fn(),
  createAdminMock: vi.fn(),
  publicUrlMock: vi.fn((p: string) => `https://public.example/${p}`),
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
  STORAGE_BUCKET: 'product-images',
  publicImageUrl: publicUrlMock,
}));

import { POST } from '../route';
import { ServiceError } from '@/lib/authz/errors';

function makeAdmin(uploadResult: unknown) {
  const uploadFn = vi.fn().mockResolvedValue(uploadResult);
  const fromFn = vi.fn(() => ({ upload: uploadFn }));
  return { __uploadFn: uploadFn, __fromFn: fromFn, storage: { from: fromFn } };
}

function makeFile(overrides: Partial<{ type: string; size: number; name: string }> = {}) {
  return {
    type: overrides.type ?? 'image/jpeg',
    size: overrides.size ?? 1234,
    name: overrides.name ?? 'photo.JPG',
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
  };
}
function req(file: unknown) {
  const form = { get: vi.fn((k: string) => (k === 'file' ? file : null)) };
  return { formData: vi.fn().mockResolvedValue(form), __form: form } as never;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('authorization', () => {
  it('unauthenticated → 401; requireActor(writers); no formData, no admin, no storage', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    const file = makeFile();
    const rq = req(file);
    const res = await POST(rq);
    expect(res.status).toBe(401);
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect((rq as { formData: ReturnType<typeof vi.fn> }).formData).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });

  it('viewer → 403; no file read, no admin, no storage', async () => {
    requireActorMock.mockRejectedValue(new ServiceError('FORBIDDEN', 'Role viewer not allowed', 403));
    const file = makeFile();
    const rq = req(file);
    const res = await POST(rq);
    expect(res.status).toBe(403);
    expect((rq as { formData: ReturnType<typeof vi.fn> }).formData).not.toHaveBeenCalled();
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(createAdminMock).not.toHaveBeenCalled();
  });
});

describe('owner/editor happy path', () => {
  it.each([['owner'], ['editor']])('%s → 200; uploads to ai-autofill-temp/ in product-images', async (role) => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role });
    const admin = makeAdmin({ error: null });
    createAdminMock.mockReturnValue(admin);
    const res = await POST(req(makeFile()));
    expect(requireActorMock).toHaveBeenCalledWith(['owner', 'editor']);
    expect(res.status).toBe(200);
    const body = await res.json();
    // bucket + path prefix preserved
    expect(admin.__fromFn).toHaveBeenCalledWith('product-images');
    const [path, , opts] = admin.__uploadFn.mock.calls[0]!;
    expect(path).toMatch(/^ai-autofill-temp\/.+\.(jpg|png|webp)$/);
    // upsert + contentType behaviour preserved
    expect(opts).toMatchObject({ upsert: false, contentType: 'image/jpeg' });
    // response shape preserved
    expect(body.data).toMatchObject({ path, size_bytes: 1234, content_type: 'image/jpeg' });
    expect(body.data.url).toBe(`https://public.example/${path}`);
  });
});

describe('invocation order', () => {
  it('auth before formData, arrayBuffer, admin client, and Storage upload', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    const admin = makeAdmin({ error: null });
    createAdminMock.mockReturnValue(admin);
    const file = makeFile();
    const rq = req(file);
    await POST(rq);
    const a = requireActorMock.mock.invocationCallOrder[0]!;
    expect(a).toBeLessThan((rq as { formData: ReturnType<typeof vi.fn> }).formData.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(file.arrayBuffer.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(createAdminMock.mock.invocationCallOrder[0]!);
    expect(a).toBeLessThan(admin.__uploadFn.mock.invocationCallOrder[0]!);
  });
});

describe('storage failure', () => {
  it('→ 500 STORAGE_UPLOAD_FAILED / "Image upload failed"; no raw text; logs real error', async () => {
    requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' });
    createAdminMock.mockReturnValue(makeAdmin({ error: { message: 'bucket policy denies object insert xyz' } }));
    const res = await POST(req(makeFile()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('STORAGE_UPLOAD_FAILED');
    expect(body.error.message).toBe('Image upload failed');
    expect(JSON.stringify(body)).not.toContain('bucket policy');
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('existing file validation preserved (owner)', () => {
  beforeEach(() => requireActorMock.mockResolvedValue({ id: 'u', email: 'a@x.com', role: 'owner' }));

  it('no file → 400 NO_FILE', async () => {
    createAdminMock.mockReturnValue(makeAdmin({ error: null }));
    const res = await POST(req(null));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NO_FILE');
  });

  it('bad format → 400 BAD_FORMAT', async () => {
    createAdminMock.mockReturnValue(makeAdmin({ error: null }));
    const res = await POST(req(makeFile({ type: 'image/gif' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('BAD_FORMAT');
  });

  it('too large → 400 TOO_LARGE', async () => {
    createAdminMock.mockReturnValue(makeAdmin({ error: null }));
    const res = await POST(req(makeFile({ size: 5 * 1024 * 1024 + 1 })));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('TOO_LARGE');
  });
});
