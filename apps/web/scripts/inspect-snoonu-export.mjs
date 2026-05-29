/**
 * One-shot Snoonu xlsx inspector — plain ESM, no tsx needed.
 *
 * Usage from repo root:
 *   node apps/web/scripts/inspect-snoonu-export.mjs
 *   node apps/web/scripts/inspect-snoonu-export.mjs "C:\\path\\to\\file.xlsx"
 */

import XLSX from 'xlsx';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PATH =
  'C:\\Users\\gulfm\\AppData\\Roaming\\Claude\\local-agent-mode-sessions\\fc606762-9754-469c-a3e3-b6bdee1b069d\\2ea2fbf7-59f8-462a-aaf5-99b75de41d63\\local_3487ef0d-a607-42a7-9496-4749eae92242\\uploads\\snoonu1.xlsx';

function classify(header) {
  const h = String(header || '').toLowerCase();
  if (/spi|unique.?identifier/.test(h)) return 'ID:SPI';
  if (/name.*\(en\)|name en/.test(h)) return 'NAME_EN';
  if (/name.*\(ar\)|name ar/.test(h)) return 'NAME_AR';
  if (/description.*\(en\)|description en/.test(h)) return 'DESC_EN';
  if (/description.*\(ar\)|description ar/.test(h)) return 'DESC_AR';
  if (/price.*ali bin abdullah/.test(h)) return 'PRICE_ALI';
  if (/price.*aziziyah/.test(h)) return 'PRICE_AZIZIYAH';
  if (/availability.*ali bin abdullah/.test(h)) return 'AVAIL_ALI';
  if (/availability.*aziziyah/.test(h)) return 'AVAIL_AZIZIYAH';
  if (/stock.*ali bin abdullah/.test(h)) return 'STOCK_ALI';
  if (/stock.*aziziyah/.test(h)) return 'STOCK_AZIZIYAH';
  if (/^stock$/.test(h)) return 'STOCK_TOTAL';
  if (/sku/.test(h)) return 'SKU';
  if (/barcode/.test(h)) return 'BARCODE';
  if (/category|catalog/.test(h)) return 'CATEGORY?';
  if (/image|photo|picture/.test(h)) return 'IMAGE';
  return 'OTHER';
}

const path = process.argv[2] ?? DEFAULT_PATH;
if (!existsSync(path)) {
  console.error(`File not found: ${path}`);
  process.exit(1);
}

console.log(`File: ${path}`);
console.log(`Size: ${statSync(path).size.toLocaleString()} bytes\n`);

const wb = XLSX.readFile(resolve(path));
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  console.log(`── Sheet: ${name} ── rows=${rows.length}`);
  if (rows.length === 0) continue;
  const headers = Object.keys(rows[0]);
  console.log(`  columns=${headers.length}\n`);

  console.log('  HEADERS:');
  headers.forEach((h, i) => {
    const tag = classify(h);
    console.log(`    [${String(i + 1).padStart(2, '0')}] ${tag.padEnd(15)} │ ${h}`);
  });

  for (const idx of [0, 1, 2]) {
    if (!rows[idx]) continue;
    console.log(`\n  SAMPLE ROW ${idx + 1} (non-empty fields):`);
    for (const h of headers) {
      const v = rows[idx][h];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        const s = String(v);
        console.log(`    ${h}: ${s.length > 120 ? s.slice(0, 120) + '…' : s}`);
      }
    }
  }

  console.log('\n  COVERAGE % (top 25):');
  const cov = headers.map((h) => {
    const filled = rows.filter(
      (r) => r[h] !== null && r[h] !== undefined && String(r[h]).trim() !== '',
    ).length;
    return { h, pct: (filled / rows.length) * 100, filled };
  });
  cov.sort((a, b) => b.pct - a.pct).slice(0, 25).forEach(({ h, pct, filled }) => {
    console.log(`    ${pct.toFixed(1).padStart(5)}%  (${filled}/${rows.length})  ${h}`);
  });
  console.log('');
}
