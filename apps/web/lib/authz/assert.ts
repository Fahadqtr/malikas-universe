/**
 * Central role-assertion policy. Both `BaseService.requireRole` and
 * `requireActor` delegate here, so there is exactly one place that decides
 * whether a role is allowed. Depends only on leaf modules (roles/errors/types)
 * — no Supabase, no Next — so it is trivially unit-testable and cycle-free.
 */
import { isAppRole, type AppRole } from './roles';
import { ServiceError } from './errors';
import type { Actor } from './types';

/**
 * Throw a 403 `ServiceError` unless `actor.role` is a valid AppRole AND is a
 * member of `allowedRoles`.
 *
 * FAILS CLOSED:
 *   - An unknown / invalid role (not an AppRole) → 403 `INVALID_ROLE`.
 *   - An empty `allowedRoles` array → nobody passes → 403 `FORBIDDEN`.
 */
export function assertRole(
  actor: Pick<Actor, 'role'>,
  allowedRoles: readonly AppRole[],
): void {
  if (!isAppRole(actor.role)) {
    throw new ServiceError('INVALID_ROLE', 'User role is invalid', 403);
  }
  if (!allowedRoles.includes(actor.role)) {
    throw new ServiceError('FORBIDDEN', `Role ${actor.role} not allowed`, 403);
  }
}
