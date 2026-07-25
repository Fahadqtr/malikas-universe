/**
 * Unit tests for getActor(). Supabase clients are fully mocked — no network.
 * Verifies the ordered, fail-closed gate and that the admin (service-role)
 * client is never built when auth fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serverClientMock, adminClientMock, getUserMock, singleMock } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const singleMock = vi.fn();
  const serverClientMock = vi.fn(() => ({ auth: { getUser: getUserMock } }));
  const adminClientMock = vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ single: singleMock }) }) }),
  }));
  return { serverClientMock, adminClientMock, getUserMock, singleMock };
});

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: serverClientMock,
  createAdminSupabaseClient: adminClientMock,
}));

import { getActor } from '@/lib/actor';
import { ServiceError } from '@/lib/authz/errors';

const USER = { id: 'user-123' };
function profile(overrides: Record<string, unknown> = {}) {
  return { data: { id: 'user-123', email: 'staff@example.com', role: 'owner', is_active: true, ...overrides }, error: null };
}

beforeEach(() => vi.clearAllMocks());

it('1. missing user → 401', async () => {
  getUserMock.mockResolvedValue({ data: { user: null }, error: null });
  await expect(getActor()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
});

it('2. auth error → 401', async () => {
  getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
  await expect(getActor()).rejects.toMatchObject({ status: 401 });
});

it('3. admin client is NOT created when auth fails', async () => {
  getUserMock.mockResolvedValue({ data: { user: null }, error: null });
  await expect(getActor()).rejects.toBeInstanceOf(ServiceError);
  expect(adminClientMock).not.toHaveBeenCalled();
});

it('4. missing profile → 403 NO_PROFILE', async () => {
  getUserMock.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue({ data: null, error: null });
  await expect(getActor()).rejects.toMatchObject({ status: 403, code: 'NO_PROFILE' });
});

it('5. profile query error → 403 without leaking DB details', async () => {
  getUserMock.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue({ data: null, error: { message: 'relation user_profiles does not exist' } });
  try {
    await getActor();
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    expect((e as ServiceError).status).toBe(403);
    expect((e as ServiceError).message).not.toContain('user_profiles');
    expect((e as ServiceError).message).not.toContain('relation');
  }
});

it('6. inactive account → 403 INACTIVE', async () => {
  getUserMock.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue(profile({ is_active: false }));
  await expect(getActor()).rejects.toMatchObject({ status: 403, code: 'INACTIVE' });
});

it('7. invalid DB role → fail-closed 403 INVALID_ROLE', async () => {
  getUserMock.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue(profile({ role: 'superadmin' }));
  await expect(getActor()).rejects.toMatchObject({ status: 403, code: 'INVALID_ROLE' });
});

it('8/9/10. valid owner/editor/viewer return a correct Actor', async () => {
  getUserMock.mockResolvedValue({ data: { user: USER }, error: null });
  for (const role of ['owner', 'editor', 'viewer'] as const) {
    singleMock.mockResolvedValueOnce(profile({ role }));
    await expect(getActor()).resolves.toEqual({ id: 'user-123', email: 'staff@example.com', role });
  }
});

it('11. role comes from the DB profile, not from any request input', async () => {
  // getActor takes no request object; the returned role must equal the admin
  // query result regardless of anything a caller could supply.
  getUserMock.mockResolvedValue({ data: { user: USER }, error: null });
  singleMock.mockResolvedValue(profile({ role: 'viewer' }));
  const actor = await getActor();
  expect(actor.role).toBe('viewer');
});
