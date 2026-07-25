/**
 * Base service class.
 * All domain services extend this for a shared Supabase client + role gate.
 *
 * `ServiceError` and `Actor` now live in `@/lib/authz/*` (single source of
 * truth) and are re-exported here so existing imports from `@/lib/services`
 * keep working. `requireRole` delegates to the central `assertRole` policy so
 * service-layer and route-layer authorization can never drift apart.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@malikas/db';
import { assertRole } from '@/lib/authz/assert';
import type { AppRole } from '@/lib/authz/roles';
import type { Actor } from '@/lib/authz/types';

// Preserve the historical `@/lib/services` surface.
export { ServiceError } from '@/lib/authz/errors';
export type { Actor } from '@/lib/authz/types';

export abstract class BaseService {
  constructor(
    protected readonly db: SupabaseClient<Database>,
    protected readonly actor: Actor,
  ) {}

  protected requireRole(roles: readonly AppRole[]): void {
    assertRole(this.actor, roles);
  }

  protected actorTag(): string {
    return this.actor.email;
  }
}
