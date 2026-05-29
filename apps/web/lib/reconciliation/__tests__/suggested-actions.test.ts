/**
 * Drift guard for suggested_action — Phase 13B.16.
 *
 * Asserts that:
 *   1. Every literal the comparator emits in its body appears in ALLOWED_SUGGESTED_ACTIONS
 *   2. The migration SQL contains every literal in ALLOWED_SUGGESTED_ACTIONS
 *
 * If either drifts, tests fail with the exact missing value(s).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALLOWED_SUGGESTED_ACTIONS } from '../suggested-actions';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COMPARATOR_PATH = path.join(REPO_ROOT, 'apps/web/lib/reconciliation/comparator.ts');
const MIGRATION_0016 = path.join(REPO_ROOT, 'supabase/migrations/00000000000016_suggested_actions_align.sql');

describe('suggested_action drift guard', () => {
  it('every suggested_action literal in comparator.ts is in ALLOWED_SUGGESTED_ACTIONS', () => {
    const src = fs.readFileSync(COMPARATOR_PATH, 'utf8');
    // Match `suggested_action: 'value'` and `suggested_action:\n      'value'`
    const re = /suggested_action\s*:\s*['"]([a-z_]+)['"]/g;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) found.add(m[1]);

    const missing = [...found].filter((v) => !(ALLOWED_SUGGESTED_ACTIONS as readonly string[]).includes(v));
    expect(missing).toEqual([]);
  });

  it('migration 0016 contains every action in ALLOWED_SUGGESTED_ACTIONS', () => {
    const sql = fs.readFileSync(MIGRATION_0016, 'utf8');
    const missing = ALLOWED_SUGGESTED_ACTIONS.filter((a) => !sql.includes(`'${a}'`));
    expect(missing).toEqual([]);
  });

  it('ALLOWED_SUGGESTED_ACTIONS has no duplicates', () => {
    const set = new Set(ALLOWED_SUGGESTED_ACTIONS);
    expect(set.size).toBe(ALLOWED_SUGGESTED_ACTIONS.length);
  });
});
