/**
 * One-shot Snoonu export inspector.
 *
 * Reads the uploaded Snoonu xlsx and prints:
 *   - sheet info (name, rows, cols)
 *   - full header list with index
 *   - 2 sample rows showing non-empty cells
 *   - column hints classified by purpose
 *
 * Usage:
 *   pnpm --filter web exec tsx scripts/inspect-snoonu-export.ts <path-to-xlsx>
 *
 * Default path is the cowork uploads directory for snoonu1.xlsx.
 */

import * as XLSX from 'xlsx';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PATH =
  'C:\\Users\\gulfm\\AppData\\Roaming\\Claude\\local-agent-mode-sessions\\fc606762-9754-469c-a3e3-b6bdee1b069d\\2ea2fbf7-59f8-462a-aaf5-99b75de41d63\\local_3487ef0d-a607-42a7-9496-4749eae92242\\uploads\\snoonu1.xlsx';

function classify(header: string): string {
  const h = header.toLowerCase();
  if (/spi|unique.?identifier/.test(h)) return 'ID:SPI';
  if (/name.*en|product name \(en\)/.test(h)) return 'NAME_EN';
  if (/name.*ar|product name \(ar\)/.test(h)) return 'NAME_AR';
  if (/description.*en/.test(h)) return 'DESC_EN';
  if (/description.*ar/.test(h)) return 'DESC_AR';
  if (/price.*ali bin abdullah/i.test(h)) return 'PRICE_ALI';
  if (/price.*aziziyah/i.test(h)) return 'PRICE_AZIZIYAH';
  if (/availability.*ali bin abdullah/i.test(h)) return 'AVAIL_ALI';
  if (/availability.*aziziyah/i.test(h)) return 'AVAIL_AZIZIYAH';
  if (/stock.*ali bin abdullah/i.test(h)) return 'STOCK_ALI';
  if (/stock.*aziziyah/i.test(h)) return 'STOCK_AZIZIYAH';
  if (/^stock$/i.test(h)) return 'STOCK_TOTAL';
  if (/^sku\b|sku\(update\)/i.test(h)) return 'SKU';
  if (/barcode/i.test(h)) return 'BARCODE';
  if (/category|catalog/i.test(h)) return 'CATEGORY?';
  if (/image|photo|picture/i.test(h)) return 'IMAGE';
  return 'OTHER';
}

function main() {
  const path = process.argv[2] ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  console.log(`File: ${path}`);
  console.log(`Size: ${statSync(path).size.toLocaleString()} bytes\n`);

  const wb = XLSX.readFile(resolve(path));
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
      defval: null,
      raw: true,
    });
    console.log(`── Sheet: ${name} ── rows=${rows.length}`);
    if (rows.length === 0) continue;
    const headers = Object.keys(rows[0]!);
    console.log(`  columns=${headers.length}\n`);

    console.log('  HEADERS (with classification):');
    headers.forEach((h, i) => {
      const tag = classify(h);
      console.log(`    [${String(i + 1).padStart(2, '0')}] ${tag.padEnd(15)} │ ${h}`);
    });

    console.log('\n  SAMPLE ROW 1 (non-empty fields):');
    const r1 = rows[0]!;
    for (const h of headers) {
      const v = r1[h];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        const s = String(v);
        console.log(`    ${h}: ${s.length > 100 ? s.slice(0, 100) + '…' : s}`);
      }
    }

    console.log('\n  SAMPLE ROW 2 (non-empty fields):');
    const r2 = rows[1] ?? {};
    for (const h of headers) {
      const v = r2[h];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        const s = String(v);
        console.log(`    ${h}: ${s.length > 100 ? s.slice(0, 100) + '…' : s}`);
      }
    }

    // Coverage report — % rows with non-empty value per column
    console.log('\n  COVERAGE (% non-empty per column, top 20):');
    const coverage = headers.map((h) => {
      const filled = rows.filter(
        (r) => r[h] !== null && r[h] !== undefined && String(r[h]).trim() !== '',
      ).length;
      return { h, pct: (filled / rows.length) * 100, filled };
    });
    coverage
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 20)
      .forEach(({ h, pct, filled }) => {
        console.log(`    ${pct.toFixed(1).padStart(5)}%  (${filled}/${rows.length})  ${h}`);
      });
    console.log('');
  }
}

main();
