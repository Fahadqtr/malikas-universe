/**
 * Unit tests for the authorization foundation: role vocabulary, `assertRole`,
 * and `requireActor`. `getActor` is mocked so no Supabase/network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/actor', () => ({ getActor: vi.fn() }));

import { getActor } from '@/lib/actor';
import { requireActor, assertRole } from '@/lib/authorization';
import { APP_ROLES, ROLE_SETS, isAppRole } from '@/lib/authz/roles';
import { ServiceError } from '@/lib/authz/errors';
import type { Actor } from '@/lib/authz/types';

const getActorMock = vi.mocked(getActor);

function actorWith(role: string): Actor {
  return { id: 'u1', email: 'x@example.com', role: role as Actor['role'] };
}

beforeEach(() => vi.clearAllMocks());

describe('role vocabulary', () => {
  it('APP_ROLES is exactly owner/editor/viewer', () => {
    expect([...APP_ROLES]).toEqual(['owner', 'editor', 'viewer']);
  });
  it('isAppRole accepts each valid role', () => {
    expect(isAppRole('owner')).toBe(true);   // 1
    expect(isAppRole('editor')).toBe(true);  // 2
    expect(isAppRole('viewer')).toBe(true);  // 3
  });
  it('isAppRole rejects unknown / null / non-string', () => { // 4
    expect(isAppRole('admin')).toBe(false);
    expect(isAppRole('')).toBe(false);
    expect(isAppRole(null)).toBe(false);
    expect(isAppRole(undefined)).toBe(false);
    expect(isAppRole(1)).toBe(false);
  });
  it('ROLE_SETS are the expected groupings', () => {
    expect([...ROLE_SETS.ownerOnly]).toEqual(['owner']);
    expect([...ROLE_SETS.writers]).toEqual(['owner', 'editor']);
    expect([...ROLE_SETS.readers]).toEqual(['owner', 'editor', 'viewer']);
  });
});

describe('assertRole', () => {
  it('ownerOnly: allows owner, blocks editor and viewer', () => { // 6,7,8
    expect(() => assertRole(actorWith('owner'), ROLE_SETS.ownerOnly)).not.toThrow();
    expect(() => assertRole(actorWith('editor'), ROLE_SETS.ownerOnly)).toThrow(ServiceError);
    expect(() => assertRole(actorWith('viewer'), ROLE_SETS.ownerOnly)).toThrow(ServiceError);
  });
  it('writers: allows owner and editor, blocks viewer', () => { // 9,10,11
    expect(() => assertRole(actorWith('owner'), ROLE_SETS.writers)).not.toThrow();
    expect(() => assertRole(actorWith('editor'), ROLE_SETS.writers)).not.toThrow();
    expect(() => assertRole(actorWith('viewer'), ROLE_SETS.writers)).toThrow(ServiceError);
  });
  it('a disallowed role throws ServiceError with status 403 and FORBIDDEN', () => { // 12
    try {
      assertRole(actorWith('viewer'), ROLE_SETS.ownerOnly);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError);
      expect((e as ServiceError).status).toBe(403);
      expect((e as ServiceError).code).toBe('FORBIDDEN');
    }
  });
  it('empty allowedRoles fails closed (nobody passes)', () => { // 13
    for (const r of APP_ROLES) {
      expect(() => assertRole(actorWith(r), [])).toThrow(ServiceError);
    }
  });
  it('an invalid role fails closed with INVALID_ROLE 403', () => {
    try {
      assertRole(actorWith('superuser'), ROLE_SETS.readers);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ServiceError).code).toBe('INVALID_ROLE');
      expect((e as ServiceError).status).toBe(403);
    }
  });
});

describe('requireActor', () => {
  it('with no roles, allows every valid authenticated role', async () => { // 5
    for (const r of APP_ROLES) {
      getActorMock.mockResolvedValueOnce(actorWith(r));
      await expect(requireActor()).resolves.toEqual(actorWith(r));
    }
  });
  it('requireActor(["owner"]) allows owner, blocks editor & viewer', async () => {
    getActorMock.mockResolvedValueOnce(actorWith('owner'));
    await expect(requireActor(['owner'])).resolves.toEqual(actorWith('owner'));
    getActorMock.mockResolvedValueOnce(actorWith('editor'));
    await expect(requireActor(['owner'])).rejects.toMatchObject({ status: 403 });
    getActorMock.mockResolvedValueOnce(actorWith('viewer'));
    await expect(requireActor(['owner'])).rejects.toMatchObject({ status: 403 });
  });
  it('requireActor(ROLE_SETS.writers) blocks viewer', async () => {
    getActorMock.mockResolvedValueOnce(actorWith('viewer'));
    await expect(requireActor(ROLE_SETS.writers)).rejects.toBeInstanceOf(ServiceError);
  });
  it('requireActor([]) fails closed even for owner', async () => {
    getActorMock.mockResolvedValueOnce(actorWith('owner'));
    await expect(requireActor([])).rejects.toMatchObject({ status: 403 });
  });
  it('propagates an auth failure from getActor (401)', async () => {
    getActorMock.mockRejectedValueOnce(new ServiceError('UNAUTHORIZED', 'Login required', 401));
    await expect(requireActor(['owner'])).rejects.toMatchObject({ status: 401 });
  });
});
