/**
 * GET /api/reconciliation/health
 *
 * Diagnostic for the reconciliation system. Checks which expected columns,
 * tables, and CHECK-constraint values are present so missing migrations
 * surface as actionable messages instead of "schema cache" errors.
 *
 * Use it after every code pull to confirm migrations are applied.
 *
 * Returns:
 *   {
 *     ok: true,
 *     ready: boolean,             // every expected column exists
 *     migrations: [
 *       { id: '0012', name: 'reconciliation core', applied: true|false, missing: [...] },
 *       { id: '0013', name: 'smart matching',     applied: true|false, missing: [...] },
 *       { id: '0014', name: 'finding snapshots',  applied: true|false, missing: [...] },
 *       { id: '0015', name: 'category extraction', applied: true|false, missing: [...] },
 *     ],
 *     remediation: 'Apply these migrations in Supabase SQL Editor: …'
 *   }
 */

import { ok, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient } from '@/lib/supabase/server';
import { ALLOWED_SUGGESTED_ACTIONS } from '@/lib/reconciliation/suggested-actions';

export const runtime = 'nodejs';

type MigrationCheck = {
  id: string;
  name: string;
  filename: string;
  table: string;
  expected_columns: string[];
};

const EXPECTED: MigrationCheck[] = [
  {
    id: '0012',
    name: 'reconciliation core',
    filename: '00000000000012_reconciliation.sql',
    table: 'platform_imports',
    expected_columns: ['id', 'platform', 'status', 'total_rows', 'parsed_rows', 'matched_rows'],
  },
  {
    id: '0012',
    name: 'reconciliation core',
    filename: '00000000000012_reconciliation.sql',
    table: 'reconciliation_findings',
    expected_columns: ['id', 'run_id', 'finding_type', 'severity', 'baseline_value', 'target_value'],
  },
  {
    id: '0013',
    name: 'smart matching',
    filename: '00000000000013_reconciliation_smart_matching.sql',
    table: 'platform_products',
    expected_columns: [
      'normalized_name', 'normalized_brand', 'name_root', 'name_token_signature',
      'variant_color', 'variant_shade', 'variant_size',
      'variant_volume_value', 'variant_volume_unit', 'variant_pack',
      'variant_model', 'variant_type',
      'image_hash', 'image_width', 'image_height',
    ],
  },
  {
    id: '0013',
    name: 'smart matching',
    filename: '00000000000013_reconciliation_smart_matching.sql',
    table: 'reconciliation_findings',
    expected_columns: ['confidence', 'candidate_pairs', 'differing_tokens', 'variant_family_id'],
  },
  {
    id: '0013',
    name: 'smart matching',
    filename: '00000000000013_reconciliation_smart_matching.sql',
    table: 'platform_product_mappings',
    expected_columns: ['id', 'baseline_platform', 'target_platform', 'mapping_type'],
  },
  {
    id: '0014',
    name: 'finding snapshots',
    filename: '00000000000014_finding_snapshots.sql',
    table: 'reconciliation_findings',
    expected_columns: ['baseline_snapshot', 'target_snapshot', 'matching_reason'],
  },
  {
    id: '0015',
    name: 'category extraction',
    filename: '00000000000015_category_extraction.sql',
    table: 'platform_products',
    expected_columns: [
      'raw_category', 'raw_subcategory', 'category_name', 'subcategory_name',
      'category_confidence', 'category_source', 'category_missing',
    ],
  },
  // 0016 is column-less (constraint-only) so it's checked via
  // suggested_action_check below, not via expected_columns.
];

export const GET = withErrorHandling(async () => {
  const admin = createAdminSupabaseClient();

  // Pull every column the system knows about across the relevant tables in
  // a single round-trip.
  const tables = Array.from(new Set(EXPECTED.map((e) => e.table)));
  const { data: cols } = await admin
    .from('information_schema.columns')
    .select('table_name, column_name')
    .eq('table_schema', 'public')
    .in('table_name', tables);

  const presentByTable = new Map<string, Set<string>>();
  for (const r of cols ?? []) {
    const row = r as { table_name: string; column_name: string };
    if (!presentByTable.has(row.table_name)) presentByTable.set(row.table_name, new Set());
    presentByTable.get(row.table_name)!.add(row.column_name);
  }

  // Reduce per-migration results
  const byMigration = new Map<
    string,
    { id: string; name: string; filename: string; missing: Array<{ table: string; column: string }> }
  >();

  for (const check of EXPECTED) {
    const present = presentByTable.get(check.table) ?? new Set<string>();
    const missingCols = check.expected_columns.filter((c) => !present.has(c));
    const entry = byMigration.get(check.id) ?? {
      id: check.id,
      name: check.name,
      filename: check.filename,
      missing: [],
    };
    for (const c of missingCols) entry.missing.push({ table: check.table, column: c });
    if (!presentByTable.has(check.table)) {
      // Whole table is missing
      entry.missing.push({ table: check.table, column: '<TABLE MISSING>' });
    }
    byMigration.set(check.id, entry);
  }

  const migrations = Array.from(byMigration.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({ ...m, applied: m.missing.length === 0 }));

  const missingMigrations = migrations.filter((m) => !m.applied);
  const ready = missingMigrations.length === 0;

  const remediation = ready
    ? 'All reconciliation migrations are applied. System is ready.'
    : [
        'Apply these migrations in Supabase SQL Editor (in order):',
        ...missingMigrations.map((m) => `  • supabase/migrations/${m.filename}  (migration ${m.id} — ${m.name})`),
        '',
        `Missing columns: ${missingMigrations
          .flatMap((m) => m.missing.map((c) => `${c.table}.${c.column}`))
          .join(', ')}`,
      ].join('\n');

  // ─── Phase 13B.16: suggested_action CHECK constraint audit ─────────────
  // Read the constraint definition out of pg_catalog and verify it contains
  // every action in ALLOWED_SUGGESTED_ACTIONS.
  let actionsCheckOk = false;
  let actionsCheckMissing: string[] = [];
  let actionsCheckDefinition: string | null = null;
  try {
    const { data: ck } = await admin
      .from('information_schema.check_constraints' as 'information_schema.check_constraints')
      .select('check_clause')
      .eq('constraint_name', 'reconciliation_findings_suggested_action_check')
      .maybeSingle();
    const clause = ((ck as { check_clause?: string } | null)?.check_clause ?? '') as string;
    actionsCheckDefinition = clause || null;
    actionsCheckMissing = ALLOWED_SUGGESTED_ACTIONS.filter(
      (a) => !clause.includes(`'${a}'`),
    );
    actionsCheckOk = actionsCheckDefinition !== null && actionsCheckMissing.length === 0;
  } catch {
    actionsCheckOk = false;
    actionsCheckDefinition = null;
    actionsCheckMissing = [...ALLOWED_SUGGESTED_ACTIONS];
  }

  const fullyReady = ready && actionsCheckOk;

  return ok({
    ready: fullyReady,
    migrations,
    suggested_action_check: {
      ok: actionsCheckOk,
      missing_from_db: actionsCheckMissing,
      constraint_present: actionsCheckDefinition !== null,
      remediation: actionsCheckOk
        ? 'CHECK constraint accepts every value in ALLOWED_SUGGESTED_ACTIONS.'
        : actionsCheckDefinition === null
        ? 'reconciliation_findings_suggested_action_check is missing. Apply migration 0016.'
        : `CHECK constraint is missing these actions: ${actionsCheckMissing.join(', ')}. Apply migration 0016.`,
    },
    remediation: fullyReady
      ? 'All reconciliation migrations are applied AND the suggested_action CHECK constraint matches code. System is ready.'
      : (ready ? remediation : remediation + '\n\nAlso: ' + (actionsCheckOk ? '' : 'apply migration 0016 to align suggested_action CHECK.')),
    checked_tables: tables,
  });
});
