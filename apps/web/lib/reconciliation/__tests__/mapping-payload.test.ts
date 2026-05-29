/**
 * Mapping payload resolver — invariant tests.
 *
 * Asserts that buildMappingPayload NEVER produces an unusable payload, even
 * for findings with empty snapshots, missing SKUs, missing barcodes, etc.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMappingPayload,
  syntheticSku,
  assertPayloadHasStableKeys,
} from '../mapping-payload';

describe('buildMappingPayload', () => {
  it('uses baseline_snapshot.matched_master_sku when present', () => {
    const p = buildMappingPayload({
      baseline_snapshot: { matched_master_sku: 'MK-SKIN-0001', source_sku: 'SNN-001', name_en: 'Foo' },
      target_snapshot: { source_sku: 'TLB-9', name_en: 'Foo' },
      baseline_platform: 'snoonu',
      target_platform: 'talabat',
    });
    expect(p).not.toBeNull();
    expect(p!.baseline_master_sku).toBe('MK-SKIN-0001');
    expect(p!.resolved_via.master_sku).toBe('baseline_snapshot.matched_master_sku');
    expect(p!.baseline_source_sku).toBe('SNN-001');
    expect(p!.target_source_sku).toBe('TLB-9');
    expect(p!.is_synthetic).toBe(false);
  });

  it('falls back to joined baseline_product when snapshot is empty', () => {
    const p = buildMappingPayload({
      baseline_snapshot: null,
      baseline_product: { matched_master_sku: 'MK-MAKEUP-0007', source_sku: 'SNN-7', name_en: 'Bar' },
      target_snapshot: { source_sku: 'RAF-77', name_en: 'Bar' },
      baseline_platform: 'snoonu',
      target_platform: 'rafeeq',
    });
    expect(p!.baseline_master_sku).toBe('MK-MAKEUP-0007');
    expect(p!.resolved_via.master_sku).toBe('baseline_product.matched_master_sku');
    expect(p!.resolved_via.baseline_sku).toBe('baseline_product.source_sku');
  });

  it('falls back to barcode when no SKU exists', () => {
    const p = buildMappingPayload({
      baseline_snapshot: { barcode: '8809123456789', name_en: 'Foo Cleanser' },
      target_snapshot: { barcode: '8809123456789', name_en: 'Foo Cleanser' },
      baseline_platform: 'snoonu',
      target_platform: 'talabat',
    });
    expect(p!.baseline_source_sku).toBe('BARCODE:8809123456789');
    expect(p!.resolved_via.baseline_sku).toBe('baseline_snapshot.barcode');
    expect(p!.target_source_sku).toBe('BARCODE:8809123456789');
    expect(p!.is_synthetic).toBe(false);
  });

  it('falls back to synthetic SKU when nothing usable on a side', () => {
    const p = buildMappingPayload({
      baseline_snapshot: { name_en: 'Urban Decay All Nighter Setting Spray (Mini Size)' },
      target_snapshot: { source_sku: 'TLB-XX' },
      baseline_platform: 'snoonu',
      target_platform: 'talabat',
    });
    expect(p).not.toBeNull();
    expect(p!.baseline_source_sku).toBe(
      'AUTO::urban-decay-all-nighter-setting-spray-mini-size::snoonu',
    );
    expect(p!.is_synthetic).toBe(true);
    expect(p!.synthetic_sides).toContain('baseline');
    expect(p!.synthetic_sides).not.toContain('target');
    expect(p!.resolved_via.baseline_sku).toBe('synthetic');
  });

  it('uses synthetic SKU on BOTH sides when neither has SKU or barcode', () => {
    const p = buildMappingPayload({
      baseline_snapshot: { name_en: 'Foo Cleanser' },
      target_snapshot: { name_en: 'Foo Cleanser Different Brand' },
      baseline_platform: 'snoonu',
      target_platform: 'rafeeq',
    });
    expect(p!.is_synthetic).toBe(true);
    expect(p!.synthetic_sides).toEqual(['baseline', 'target']);
    expect(p!.baseline_source_sku).toMatch(/^AUTO::.+::snoonu$/);
    expect(p!.target_source_sku).toMatch(/^AUTO::.+::rafeeq$/);
  });

  it('returns null only when BOTH sides are completely empty', () => {
    const p = buildMappingPayload({
      baseline_snapshot: null,
      baseline_product: null,
      target_snapshot: null,
      target_product: null,
      baseline_platform: 'snoonu',
      target_platform: 'talabat',
    });
    expect(p).toBeNull();
  });

  it('does NOT return null if finding has master_sku even with empty snapshots', () => {
    const p = buildMappingPayload({
      baseline_snapshot: null,
      target_snapshot: { name_en: 'Something' },
      finding_master_sku: 'MK-BODY-0042',
      baseline_platform: 'snoonu',
      target_platform: 'shopify',
    });
    expect(p).not.toBeNull();
    expect(p!.baseline_master_sku).toBe('MK-BODY-0042');
    expect(p!.resolved_via.master_sku).toBe('finding.master_sku');
  });

  it('always passes assertPayloadHasStableKeys when payload is returned', () => {
    const fixtures = [
      { baseline_snapshot: { source_sku: 'A' }, target_snapshot: { source_sku: 'B' } },
      { baseline_snapshot: { barcode: '111' }, target_snapshot: { barcode: '222' } },
      { baseline_snapshot: { name_en: 'X' }, target_snapshot: { name_en: 'Y' } },
      { baseline_snapshot: { matched_master_sku: 'MK-1' }, target_snapshot: { source_sku: 'B' } },
    ];
    for (const fx of fixtures) {
      const p = buildMappingPayload({ ...fx, baseline_platform: 'snoonu', target_platform: 'talabat' });
      expect(p).not.toBeNull();
      expect(() => assertPayloadHasStableKeys(p!)).not.toThrow();
    }
  });
});

describe('syntheticSku', () => {
  it('produces stable AUTO:: slug', () => {
    expect(syntheticSku('Urban Decay All Nighter Setting Spray (Mini Size)', 'snoonu')).toBe(
      'AUTO::urban-decay-all-nighter-setting-spray-mini-size::snoonu',
    );
  });

  it('handles empty / null names', () => {
    expect(syntheticSku(null, 'talabat')).toBe('AUTO::unknown::talabat');
    expect(syntheticSku('', 'rafeeq')).toBe('AUTO::unknown::rafeeq');
    expect(syntheticSku('   ', 'shopify')).toBe('AUTO::unknown::shopify');
  });

  it('strips diacritics and punctuation', () => {
    expect(syntheticSku('Café — Naïve Édition!', 'snoonu')).toMatch(/^AUTO::cafe.*naive.*edition::snoonu$/);
  });

  it('is deterministic — same name produces same SKU', () => {
    const a = syntheticSku('Test Product', 'snoonu');
    const b = syntheticSku('Test Product', 'snoonu');
    expect(a).toBe(b);
  });
});
