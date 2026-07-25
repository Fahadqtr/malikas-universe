/**
 * Shared authorization types. Depends only on `roles` (leaf), so it can be
 * imported anywhere without a cycle.
 */
import type { AppRole } from './roles';

/**
 * The authenticated actor for a request. `role` is always a validated
 * {@link AppRole} — `getActor()` runtime-checks it via `isAppRole` before
 * constructing an Actor, so consumers never receive an unknown role.
 */
export type Actor = {
  id?: string;
  email: string;
  role: AppRole;
};
