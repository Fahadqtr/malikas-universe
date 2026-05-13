/**
 * Bulk AI Doctor — diagnoses and partially fixes the bulk AI pipeline.
 * Run via FIX-BULK-AI.bat (double-click from project root).
 *
 * What it does:
 *   1. Verifies AI columns exist on `products` (from migration 0004)
 *   2. Ensures the "Unknown" fallback brand exists — CREATES it if missing
 *   3. Verifies `ai_drafts` safety-net table exists (from migration 0005)
 *   4. Performs a real product INSERT probe to surface the EXACT db error
 *   5. If anything is wrong, writes the precise fix SQL to scripts/fix-it.sql
 *      so the .bat can open it for one-click paste into SQL Editor.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', 'apps', 'web', '.env.local');
const fixItPath = join(__dirname, 'fix-it.sql');

// Always start clean
if (existsSync(fixItPath)) unlinkSync(fixItPath);

// ─── Load env ───────────────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.local');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const fixSql = [];

console.log('');
console.log('🩺  Bulk AI Doctor');
console.log('   Project:', SUPABASE_URL);
console.log('');

// ─── 1. AI columns on products ───────────────────────────────────────────────
console.log('1. AI columns on products...');
const probe1 = await admin
  .from('products')
  .select('id, ai_generated, ai_confidence, ai_meta, usage_en, usage_ar')
  .limit(1);
const okCols = !probe1.error;
if (okCols) {
  console.log('   ✓ ai_generated, ai_confidence, ai_meta, usage_en, usage_ar exist');
} else {
  console.log('   ✗', probe1.error.message);
  fixSql.push(
    '-- 0004: AI columns',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_generated  BOOLEAN DEFAULT FALSE;',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC(3,2);',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS ai_meta       JSONB;',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS usage_en      TEXT;',
    'ALTER TABLE products ADD COLUMN IF NOT EXISTS usage_ar      TEXT;',
    '',
  );
}

// ─── 2. Unknown brand ───────────────────────────────────────────────────────
console.log('\n2. Unknown fallback brand...');
let brand_id = null;
const { data: existingBrand } = await admin
  .from('brands')
  .select('id, code')
  .ilike('name', 'Unknown')
  .maybeSingle();
if (existingBrand) {
  brand_id = existingBrand.id;
  console.log(`   ✓ Unknown brand exists (id=${brand_id}, code=${existingBrand.code})`);
} else {
  console.log('   ⚠ Unknown brand missing — creating it now via INSERT...');
  const ins = await admin
    .from('brands')
    .insert({ name: 'Unknown', name_ar: 'غير محدد', code: 'UNK', country_origin: 'Unknown' })
    .select('id')
    .single();
  if (ins.error) {
    console.log('   ✗ INSERT failed:', ins.error.message);
    fixSql.push(
      "-- Unknown brand fallback",
      "INSERT INTO brands (name, name_ar, code, country_origin) VALUES",
      "    ('Unknown', 'غير محدد', 'UNK', 'Unknown')",
      "ON CONFLICT (name) DO NOTHING;",
      '',
    );
  } else {
    brand_id = ins.data.id;
    console.log(`   ✓ Created Unknown brand → id=${brand_id}`);
  }
}

// ─── 3. ai_drafts safety table ──────────────────────────────────────────────
console.log('\n3. ai_drafts safety-net table...');
const probe3 = await admin.from('ai_drafts').select('id').limit(1);
const okDrafts = !probe3.error;
if (okDrafts) {
  console.log('   ✓ ai_drafts table exists');
} else {
  console.log('   ✗', probe3.error.message);
  fixSql.push(
    '-- 0005: ai_drafts safety-net table',
    'CREATE TABLE IF NOT EXISTS ai_drafts (',
    '    id                    BIGSERIAL PRIMARY KEY,',
    '    image_url             TEXT NOT NULL,',
    '    original_filename     TEXT,',
    '    suggestion            JSONB NOT NULL,',
    '    confidence            NUMERIC(3,2),',
    '    ai_meta               JSONB,',
    "    status                TEXT NOT NULL DEFAULT 'pending_recovery'",
    "                          CHECK (status IN ('pending_recovery','recovered','dismissed')),",
    '    error_code            TEXT,',
    '    error_message         TEXT,',
    '    failing_table         TEXT,',
    '    failing_payload       JSONB,',
    '    created_by            TEXT,',
    '    created_at            TIMESTAMPTZ DEFAULT NOW(),',
    '    recovered_at          TIMESTAMPTZ,',
    '    recovered_master_sku  TEXT REFERENCES products(master_sku) ON DELETE SET NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_ai_drafts_status ON ai_drafts(status, created_at DESC);',
    'ALTER TABLE ai_drafts ENABLE ROW LEVEL SECURITY;',
    'DROP POLICY IF EXISTS ai_drafts_all ON ai_drafts;',
    'CREATE POLICY ai_drafts_all ON ai_drafts FOR ALL USING (true) WITH CHECK (true);',
    '',
  );
}

// ─── 4. Probe a real product INSERT ─────────────────────────────────────────
console.log('\n4. Probe product INSERT (will be cleaned up)...');
let okInsert = false;
if (!brand_id) {
  console.log('   ⊘ skipped — no brand to use');
} else {
  const probe = {
    product_name_en: `__DOCTOR_PROBE_${Date.now()}`,
    product_name_ar: `__اختبار_${Date.now()}`,
    brand_id,
    category_id: 11,
    price: 0,
    stock_quantity: 0,
    stock_status: 'out_of_stock',
    product_status: 'draft',
    source_platform: 'manual',
    ai_generated: true,
    ai_confidence: 0.95,
    ai_meta: { model: 'doctor-probe', input_tokens: 0, output_tokens: 0 },
    keywords_en: ['probe'],
    keywords_ar: ['اختبار'],
    description_en: 'doctor probe — safe to delete',
    description_ar: 'اختبار — آمن للحذف',
    image_url: 'https://example.com/probe.jpg',
    image_filename: 'probe.jpg',
    created_by: 'bulk-ai-doctor',
    updated_by: 'bulk-ai-doctor',
  };
  const { data, error } = await admin.from('products').insert(probe).select('id, master_sku').single();
  if (error) {
    console.log('   ✗ INSERT failed:');
    console.log('     message:', error.message);
    console.log('     code:   ', error.code);
    console.log('     details:', error.details ?? '(none)');
    console.log('     hint:   ', error.hint ?? '(none)');
  } else {
    okInsert = true;
    console.log(`   ✓ INSERT succeeded → master_sku=${data.master_sku}, id=${data.id}`);
    const del = await admin.from('products').delete().eq('id', data.id);
    if (del.error) {
      console.log('   ⚠ cleanup failed:', del.error.message);
    } else {
      console.log('   ✓ probe row cleaned up');
    }
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log('\n📋 Summary:');
console.log(`   AI columns:     ${okCols ? '✓ OK' : '✗ FAIL'}`);
console.log(`   Unknown brand:  ${brand_id ? '✓ OK' : '✗ FAIL'}`);
console.log(`   ai_drafts:      ${okDrafts ? '✓ OK' : '✗ MISSING'}`);
console.log(`   Probe INSERT:   ${okInsert ? '✓ OK' : '✗ FAIL'}`);

if (fixSql.length > 0) {
  fixSql.unshift(
    '-- ==========================================================',
    '-- Auto-generated fix SQL by bulk-ai-doctor.mjs',
    '-- Paste this ENTIRE file into Supabase SQL Editor → Run',
    '-- ==========================================================',
    '',
  );
  fixSql.push("NOTIFY pgrst, 'reload schema';", '');
  writeFileSync(fixItPath, fixSql.join('\n'), 'utf-8');
  console.log(`\n📝 Wrote fix SQL to: scripts/fix-it.sql`);
  console.log('   The .bat will open it + Supabase SQL Editor for you.');
  process.exit(3);
}

if (okInsert) {
  console.log('\n✅ Pipeline is HEALTHY. The .bat will restart the dev server next.');
  process.exit(0);
}

console.log('\n❌ Probe INSERT failed but no schema fix could be generated.');
console.log('   The error above is the exact reason. Share it back.');
process.exit(4);
