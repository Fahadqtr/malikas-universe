/**
 * Base service class.
 * All domain services extend this for shared Supabase client + error helpers.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@malikas/db';

export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export type Actor = {
  id?: string;
  email: string;
  role: 'owner' | 'editor' | 'viewer';
};

export abstract class BaseService {
  constructor(
    protected readonly db: SupabaseClient<Database>,
    protected readonly actor: Actor,
  ) {}

  protected requireRole(roles: Array<Actor['role']>): void {
    if (!roles.includes(this.actor.role)) {
      throw new ServiceError('FORBIDDEN', `Role ${this.actor.role} not allowed`, 403);
    }
  }

  protected actorTag(): string {
    return this.actor.email;
  }
}
