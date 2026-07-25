/**
 * POST /api/import/upload
 *
 * Multipart body: { file: File }
 * Parses, runs orchestrator, persists staged rows to a temp table,
 * returns { batch_id, preview }.
 */
import { NextRequest } from 'next/server';
import { ok, err, withErrorHandling } from '@/lib/api-response';
import { createAdminSupabaseClient, createServerSupabaseClient } from '@/lib/supabase/server';
import type { Json } from '@malikas/db';
import {
  detectPlatform,
  parseFile,
  orchestrate,
  type CategoryRuleSet,
} from '@malikas/shared';

export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withErrorHandling(async (req: NextRequest) => {
  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const sourcePlatformHint = (formData.get('source_platform') as string | null) ?? null;

  if (!file) return err('NO_FILE', 'No file uploaded', 400);
  if (file.size > 5 * 1024 * 1024) return err('FILE_TOO_LARGE', 'Max 5MB', 400);

  const buffer = new Uint8Array(await file.arrayBuffer());

  // Parse
  const parsed = await parseFile(buffer, { filename: file.name, max_rows: 5000 });
  if (parsed.rows.length === 0) return err('EMPTY_FILE', 'No rows found', 400);

  // Detect platform if not given
  const detected = detectPlatform(parsed.headers);
  const platform = sourcePlatformHint ?? detected?.platform ?? 'import';
  const mapping = detected?.mapping ?? {};

  // Authenticated user
  const userClient = createServerSupabaseClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return err('UNAUTHORIZED', 'Login required', 401);

  // Load lookups via admin client
  const admin = createAdminSupabaseClient();

  const [brandsRes, catRulesRes, kwRulesRes, catRowsRes, existingBarcodesRes] = await Promise.all([
    admin.from('brands').select('id, name'),
    admin.from('category_rules').select('brand_id, category_id, default_subcategory_id'),
    admin.from('keyword_rules').select('keyword, language, category_id, subcategory_id, confidence'),
    admin.from('categories').select('id, name, code, priority'),
    admin.from('products').select('barcode').not('barcode', 'is', null),
  ]);

  if (brandsRes.error) return err('DB_ERROR', brandsRes.error.message, 500);

  // Build brand lookup
  const brand_lookup = new Map<string, number>();
  const knownBrands = new Set<string>();
  for (const b of brandsRes.data ?? []) {
    const norm = b.name.toLowerCase().trim();
    brand_lookup.set(norm, b.id);
    knownBrands.add(norm);
  }

  // Build category rule set
  const categoryById = new Map(
    (catRowsRes.data ?? []).map((c) => [c.id, { name: c.name, code: c.code }]),
  );
  const trending = (catRowsRes.data ?? []).find((c) => c.code === 'TREND');

  const brandRulesMap = new Map<string, Parameters<typeof orchestrate>[0]['category_rules']['brandRules'] extends Map<string, infer V> ? V : never>();
  for (const r of catRulesRes.data ?? []) {
    const brand = brandsRes.data?.find((b) => b.id === r.brand_id);
    const cat = categoryById.get(r.category_id);
    if (!brand || !cat) continue;
    brandRulesMap.set(brand.name.toLowerCase(), {
      brand_id: r.brand_id,
      brand_name: brand.name.toLowerCase(),
      category_id: r.category_id,
      category_name: cat.name as never,
      default_subcategory_id: r.default_subcategory_id,
      default_subcategory_name: null,
      confidence: 1.0,
    });
  }

  const keywordRules = (kwRulesRes.data ?? []).map((r) => ({
    keyword: r.keyword.toLowerCase(),
    language: r.language as 'en' | 'ar',
    category_id: r.category_id ?? trending!.id,
    category_name: (categoryById.get(r.category_id ?? -1)?.name ?? 'Trending Products') as never,
    subcategory_id: r.subcategory_id,
    subcategory_name: null,
    confidence: Number(r.confidence ?? 0.95),
  }));

  const category_rules: CategoryRuleSet = {
    brandRules: brandRulesMap,
    keywordRules,
    categoryHints: new Map(),
    fallbackCategoryId: trending?.id ?? 11,
  };

  // Validation context
  const validation_context = {
    known_brands: knownBrands,
    existing_barcodes: new Set(
      (existingBarcodesRes.data ?? []).map((r) => r.barcode!).filter(Boolean),
    ),
  };

  // Run orchestrator
  const preview = orchestrate({
    raw_rows: parsed.rows,
    mapping,
    source_platform: platform as 'snoonu' | 'shopify' | 'talabat' | 'rafeeq' | 'import',
    brand_lookup,
    category_rules,
    validation_context,
    match_candidates: { shopify: [], talabat: [], rafeeq: [], old_master: [] }, // populated in Phase 4
  });

  // Persist batch
  const { data: batch, error: batchErr } = await admin
    .from('import_batches')
    .insert({
      filename: file.name,
      source_platform: platform,
      total_rows: parsed.total_rows,
      success_rows: preview.summary.auto_import,
      error_rows: preview.summary.blocked,
      skipped_rows: 0,
      status: 'validating',
      started_at: new Date().toISOString(),
      initiated_by: user.email,
    })
    .select('id')
    .single();

  if (batchErr || !batch) return err('DB_ERROR', batchErr?.message ?? 'Insert failed', 500);

  // Stage rows in import_errors table (re-used for staged review)
  const stagedRowInserts = preview.staged.map((s) => ({
    batch_id: batch.id,
    row_number: s.raw_index,
    raw_data: s as unknown as Json,
    error_type: s.decision,
    error_message: s.decision_reason,
  }));

  if (stagedRowInserts.length > 0) {
    await admin.from('import_errors').insert(stagedRowInserts);
  }

  return ok({ batch_id: batch.id, preview });
});
