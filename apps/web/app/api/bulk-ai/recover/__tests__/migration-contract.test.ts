/**
 * Schema-contract test for migration 0026 (bulk_ai_recover_rpc).
 *
 * No Supabase connection is available in this environment, so instead of
 * executing the SQL we assert the migration file contains the guarantees the
 * recovery route depends on. If any of these regress, the atomicity/ACL
 * contract is broken and this test fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SQL = readFileSync(
  path.resolve(__dirname, '../../../../../../../supabase/migrations/00000000000026_bulk_ai_recover_rpc.sql'),
  'utf8',
);
const sql = SQL.toLowerCase();

describe('migration 0026 — recover_ai_draft contract', () => {
  it('defines the function with the expected signature (bigint, uuid, text, jsonb)', () => {
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.recover_ai_draft/);
    expect(sql).toMatch(/p_draft_id\s+bigint/);
    expect(sql).toMatch(/p_actor_id\s+uuid/);
    expect(sql).toMatch(/p_actor_email\s+text/);
    expect(sql).toMatch(/p_product_payload\s+jsonb/);
    expect(sql).toMatch(/returns\s+table/);
    expect(sql).toContain('already_recovered');
    expect(sql).toContain('master_sku');
  });

  it('is a SECURITY DEFINER plpgsql function with a locked-down search_path', () => {
    expect(sql).toMatch(/language\s+plpgsql/);
    expect(sql).toMatch(/security\s+definer/);
    expect(sql).toMatch(/set\s+search_path\s*=\s*''/);
  });

  it('locks the draft row FOR UPDATE (serializes concurrency)', () => {
    expect(sql).toMatch(/for\s+update/);
  });

  it('performs the insert + finalize in one transaction (atomic)', () => {
    expect(sql).toMatch(/insert\s+into\s+public\.products/);
    expect(sql).toMatch(/update\s+public\.ai_drafts/);
    // status flip to recovered lives in the same function body
    expect(sql).toMatch(/status\s*=\s*'recovered'/);
  });

  it('forces created_by/updated_by to actor email (uuid fallback), never from payload', () => {
    // Normal value = actor email; UUID is only the fallback when email is blank.
    expect(sql).toMatch(/coalesce\s*\(\s*nullif\s*\(\s*btrim\s*\(\s*p_actor_email\s*\)\s*,\s*''\s*\)\s*,\s*p_actor_id::text\s*\)/);
    // created_by / updated_by are NOT read out of the JSON payload.
    expect(sql).not.toMatch(/->>\s*'created_by'/);
    expect(sql).not.toMatch(/->>\s*'updated_by'/);
  });

  it('does not let the payload set master_sku (omitted from the INSERT column list)', () => {
    // master_sku is intentionally omitted so the existing trigger mints it.
    expect(sql).not.toMatch(/insert\s+into\s+public\.products\s*\([^)]*\bmaster_sku\b/);
  });

  it('returns the already-recovered branch without inserting', () => {
    expect(sql).toContain('already_recovered');
    expect(sql).toMatch(/if\s+v_draft\.status\s*=\s*'recovered'/);
  });

  it('raises DRAFT_NOT_FOUND and DRAFT_NOT_RECOVERABLE', () => {
    expect(sql).toContain('draft_not_found');
    expect(sql).toContain('draft_not_recoverable');
  });

  it('grants EXECUTE to service_role only and revokes public/anon/authenticated', () => {
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.recover_ai_draft\([^)]*\)\s+from\s+public/);
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.recover_ai_draft\([^)]*\)\s+from\s+anon/);
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+public\.recover_ai_draft\([^)]*\)\s+from\s+authenticated/);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.recover_ai_draft\([^)]*\)\s+to\s+service_role/);
    // never grant to anon or authenticated
    expect(sql).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.recover_ai_draft\([^)]*\)\s+to\s+(anon|authenticated)/);
  });
});
