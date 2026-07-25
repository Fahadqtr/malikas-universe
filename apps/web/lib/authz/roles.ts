/**
 * Single source of truth for application roles.
 *
 * This is a LEAF module — it imports nothing, so every other authz module can
 * depend on it without creating a cycle. Do not add role names or new roles
 * here without a deliberate, separate change: the whole authorization surface
 * keys off these constants.
 */

/** The only roles the application recognises. */
export const APP_ROLES = ['owner', 'editor', 'viewer'] as const;

/** Union of the valid role strings: `'owner' | 'editor' | 'viewer'`. */
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Named role sets for common authorization intents. Use these in routes/services
 * instead of re-typing literal arrays, so the policy stays consistent.
 *   - ownerOnly : destructive / administrative operations
 *   - writers   : create / update operations
 *   - readers   : read-only access (any authenticated valid role)
 */
export const ROLE_SETS = {
  ownerOnly: ['owner'],
  writers: ['owner', 'editor'],
  readers: ['owner', 'editor', 'viewer'],
} as const satisfies Record<string, readonly AppRole[]>;

/**
 * Runtime type guard: true only for a string that is a recognised AppRole.
 * Used to validate the role loaded from the database (never trust a raw cast).
 */
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (APP_ROLES as readonly string[]).includes(value);
}
