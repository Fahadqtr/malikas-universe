/**
 * Authorization entry point for API routes.
 *
 * The intended usage in a route (applied in later PRs — this PR only builds the
 * foundation and changes no routes):
 *
 *   const actor = await requireActor(['owner']);          // owner only
 *   const actor = await requireActor(ROLE_SETS.writers);  // owner + editor
 *   const actor = await requireActor();                   // any valid role
 *
 * `requireActor` runs the full ordered gate before a route does any work:
 *   1. session check + 2. load profile + 3. reject inactive + 4. validate role
 *      (all inside `getActor()`), then 5. required-role check (`assertRole`).
 * Only after this returns should a route build an admin client or touch data.
 *
 * This module re-exports the role vocabulary and `ServiceError`/`Actor` so a
 * route needs a single import. It depends on `assert` (leaf) and `actor`; it is
 * never imported by any authz leaf module, so there is no import cycle.
 */
import { getActor } from '@/lib/actor';
import { assertRole } from '@/lib/authz/assert';
import type { AppRole } from '@/lib/authz/roles';
import type { Actor } from '@/lib/authz/types';

/**
 * Authenticate the caller and (optionally) require one of `allowedRoles`.
 *
 * - `requireActor()` — any authenticated user with a valid role passes.
 * - `requireActor(['owner'])` — owner only.
 * - `requireActor(['owner','editor'])` — excludes viewer.
 * - `requireActor([])` — FAILS CLOSED (empty set → nobody passes → 403).
 *
 * Throws `ServiceError` (401 no session, 403 no profile / inactive / invalid or
 * disallowed role). Never reads a role from the request body/query/header.
 */
export async function requireActor(allowedRoles?: readonly AppRole[]): Promise<Actor> {
  const actor = await getActor();
  if (allowedRoles !== undefined) {
    assertRole(actor, allowedRoles);
  }
  return actor;
}

// Re-exports so routes/services can import everything from one place.
export { assertRole } from '@/lib/authz/assert';
export { APP_ROLES, ROLE_SETS, isAppRole } from '@/lib/authz/roles';
export type { AppRole } from '@/lib/authz/roles';
export { ServiceError } from '@/lib/authz/errors';
export type { Actor } from '@/lib/authz/types';
export { getActor } from '@/lib/actor';
