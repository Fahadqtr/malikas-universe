/**
 * Allowed `suggested_action` values for reconciliation_findings.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH.
 *
 * Both the comparator (when emitting findings) and the runs API (before
 * inserting) import from here. The DB CHECK constraint in migration 0016
 * mirrors this exact list — keep them in sync.
 *
 * If you add a new action here:
 *   1. Add the literal to ALLOWED_SUGGESTED_ACTIONS below
 *   2. Generate a new migration that drops + recreates
 *      `reconciliation_findings_suggested_action_check`
 *   3. Run migration tests
 */

export const ALLOWED_SUGGESTED_ACTIONS = [
  // ─── Comparator-emitted (Phase 13A/B) ─────────────────────────────────────
  'add_to_target',
  'remove_from_target',
  'update_target_price',
  'update_target_name',
  'update_target_category',
  'use_snoonu_image',
  'mark_oos_on_target',
  'activate_on_target',
  'deactivate_on_target',
  'resolve_variant',
  'confirm_match',
  'create_mapping',
  'review_manually',

  // ─── Operator-side resolution actions (findings/resolve endpoint) ────────
  // These can land in suggested_action when the comparator wants to nudge the
  // operator toward a specific resolution.
  'mark_matched',
  'confirm_missing',
  'ignore',
  'dismiss',

  // ─── Sync actions (Phase 13C precursors — corrected-export generators) ───
  'sync_price',
  'sync_stock',
  'sync_status',
  'sync_image',
  'sync_category',
  'sync_brand',
  'sync_name',
] as const;

export type SuggestedAction = (typeof ALLOWED_SUGGESTED_ACTIONS)[number];

/** Fast set lookup. */
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_SUGGESTED_ACTIONS);

/**
 * Runtime type-guard. Use this in the comparator/API insert path so that
 * any drift between code and DB CHECK constraint fails LOUDLY with a clear
 * error message — never silently truncates findings.
 */
export function isAllowedSuggestedAction(v: unknown): v is SuggestedAction {
  return typeof v === 'string' && ALLOWED_SET.has(v);
}

/**
 * Assert helper — throws `SUGGESTED_ACTION_INVALID` with the offending value
 * and the list of valid actions so the caller can fix it immediately.
 */
export function assertSuggestedAction(v: unknown, context: string): SuggestedAction | null {
  if (v == null) return null;
  if (isAllowedSuggestedAction(v)) return v;
  const err = new Error(
    `SUGGESTED_ACTION_INVALID: "${String(v)}" is not in ALLOWED_SUGGESTED_ACTIONS (context: ${context}). ` +
      `Valid: ${ALLOWED_SUGGESTED_ACTIONS.join(', ')}. ` +
      `If you're adding a new action, update lib/reconciliation/suggested-actions.ts AND generate a migration that drops + recreates reconciliation_findings_suggested_action_check.`,
  );
  (err as { code?: string }).code = 'SUGGESTED_ACTION_INVALID';
  throw err;
}

/**
 * Returns the exact SQL list that the CHECK constraint should contain.
 * Used by the DB-health endpoint and the migration generator script (if any).
 */
export function suggestedActionsAsSqlList(): string {
  return ALLOWED_SUGGESTED_ACTIONS.map((a) => `'${a}'`).join(', ');
}
